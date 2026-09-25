import "server-only"
/**
 * Isolated, disposable API sandbox.
 * ---------------------------------------------------------------------------
 * A sandbox is a per-tenant, TEST-environment-only data space that mirrors a
 * slice of the real API (currently `clients`) but is FULLY ISOLATED from live
 * production tables and is DISPOSABLE — it can be reset or torn down without
 * ever touching real data.
 *
 * Isolation guarantees (why this is a separate subsystem, not a flag on the
 * production tables):
 *   - Sandbox rows live in their own tables (`api_sandbox_sessions`,
 *     `api_sandbox_records`), so a bug in sandbox code can never read or write
 *     a production `clients` row.
 *   - Every row is scoped by `tenant_id` AND `sandbox_id`; a query for one
 *     tenant's sandbox can never observe another tenant's, and a stale
 *     `sandbox_id` (from a previous, disposed session) sees nothing.
 *   - Sandbox access is gated to TEST keys at the route layer
 *     (`requireEnvironment: "test"`), so a live key can never mutate it.
 *
 * Disposability:
 *   - `resetSandbox` bumps the tenant's active `sandbox_id` to a brand-new value
 *     and re-seeds disposable fixtures. All prior records are logically orphaned
 *     immediately (never returned again) and physically deleted.
 *   - `disposeSandbox` deletes the session and all its records.
 *
 * This subsystem intentionally reuses the shared pipeline for everything else
 * (auth, scopes, rate limits, idempotency, tracing, versioning) — it only owns
 * the isolated storage + fixtures.
 */
import crypto from "crypto"
import { query } from "@/lib/db"

export type SandboxSession = {
  sandboxId: string
  tenantId: number
  createdAt: string
  resetAt: string
  seededCount: number
}

export type SandboxClient = {
  client_code: string
  client_name: string
  email: string
  company_name: string | null
  status: string
  client_type: string
  created_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`api_sandbox_sessions\` (
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`sandbox_id\` CHAR(32) NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`reset_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`api_sandbox_records\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`sandbox_id\` CHAR(32) NOT NULL,
      \`resource_type\` VARCHAR(48) NOT NULL,
      \`resource_code\` VARCHAR(64) NOT NULL,
      \`data\` JSON NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_sandbox_resource\` (\`tenant_id\`, \`sandbox_id\`, \`resource_type\`, \`resource_code\`),
      KEY \`idx_sandbox_list\` (\`tenant_id\`, \`sandbox_id\`, \`resource_type\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

function ensureSchema(): Promise<void> {
  if (!ensured)
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  return ensured
}

function newSandboxId(): string {
  return crypto.randomBytes(16).toString("hex")
}

/**
 * Returns the tenant's active sandbox, creating and seeding one on first use.
 * The returned `sandboxId` is the ONLY id any read/write for this tenant may
 * use — callers must never accept a sandbox id from client input.
 */
export async function getOrCreateSandbox(tenantId: number): Promise<SandboxSession> {
  await ensureSchema()
  const rows = await query<any[]>(
    `SELECT \`sandbox_id\`, \`created_at\`, \`reset_at\` FROM \`api_sandbox_sessions\` WHERE \`tenant_id\` = ? LIMIT 1`,
    [tenantId],
  )
  if (rows[0]) {
    const count = await countRecords(tenantId, rows[0].sandbox_id, "client")
    return {
      sandboxId: String(rows[0].sandbox_id),
      tenantId,
      createdAt: String(rows[0].created_at),
      resetAt: String(rows[0].reset_at),
      seededCount: count,
    }
  }
  return resetSandbox(tenantId)
}

/**
 * Disposes any existing sandbox data for the tenant and provisions a fresh,
 * seeded sandbox with a NEW id. Idempotent enough to be a "reset to known
 * state" primitive that tests and integrators can call repeatedly.
 */
export async function resetSandbox(tenantId: number): Promise<SandboxSession> {
  await ensureSchema()
  const sandboxId = newSandboxId()
  // Physically drop every prior record for this tenant (across any prior
  // sandbox id) so a reset truly disposes the old data set.
  await query(`DELETE FROM \`api_sandbox_records\` WHERE \`tenant_id\` = ?`, [tenantId])
  await query(
    `INSERT INTO \`api_sandbox_sessions\` (\`tenant_id\`, \`sandbox_id\`, \`created_at\`, \`reset_at\`)
     VALUES (?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE \`sandbox_id\` = VALUES(\`sandbox_id\`), \`reset_at\` = NOW()`,
    [tenantId, sandboxId],
  )
  const seededCount = await seedFixtures(tenantId, sandboxId)
  const [row] = await query<any[]>(
    `SELECT \`created_at\`, \`reset_at\` FROM \`api_sandbox_sessions\` WHERE \`tenant_id\` = ? LIMIT 1`,
    [tenantId],
  )
  return {
    sandboxId,
    tenantId,
    createdAt: String(row?.created_at ?? new Date().toISOString()),
    resetAt: String(row?.reset_at ?? new Date().toISOString()),
    seededCount,
  }
}

/** Tears down the tenant's sandbox entirely (session + all records). */
export async function disposeSandbox(tenantId: number): Promise<void> {
  await ensureSchema()
  await query(`DELETE FROM \`api_sandbox_records\` WHERE \`tenant_id\` = ?`, [tenantId])
  await query(`DELETE FROM \`api_sandbox_sessions\` WHERE \`tenant_id\` = ?`, [tenantId])
}

async function countRecords(tenantId: number, sandboxId: string, resourceType: string): Promise<number> {
  const [row] = await query<any[]>(
    `SELECT COUNT(*) AS total FROM \`api_sandbox_records\`
      WHERE \`tenant_id\` = ? AND \`sandbox_id\` = ? AND \`resource_type\` = ?`,
    [tenantId, sandboxId, resourceType],
  )
  return Number(row?.total ?? 0)
}

const FIXTURE_CLIENTS: Array<Partial<SandboxClient> & { client_name: string; email: string }> = [
  { client_name: "Acme Test Industries", email: "billing@acme.test", company_name: "Acme Test Industries", client_type: "Company" },
  { client_name: "Sandbox Sole Trader", email: "solo@sandbox.test", company_name: null, client_type: "Individual" },
]

async function seedFixtures(tenantId: number, sandboxId: string): Promise<number> {
  let n = 0
  for (const fixture of FIXTURE_CLIENTS) {
    await createSandboxClient(tenantId, sandboxId, fixture)
    n++
  }
  return n
}

function sandboxClientCode(): string {
  return `SBX-CLI-${crypto.randomBytes(5).toString("hex").toUpperCase()}`
}

/**
 * Creates a disposable client inside the given sandbox. The `sandboxId` MUST be
 * the tenant's active id (from `getOrCreateSandbox`), never client-supplied.
 */
export async function createSandboxClient(
  tenantId: number,
  sandboxId: string,
  input: Partial<SandboxClient> & { client_name: string; email: string },
): Promise<SandboxClient> {
  await ensureSchema()
  const record: SandboxClient = {
    client_code: sandboxClientCode(),
    client_name: input.client_name,
    email: input.email,
    company_name: input.company_name ?? null,
    status: input.status ?? "active",
    client_type: input.client_type ?? (input.company_name ? "Company" : "Individual"),
    created_at: new Date().toISOString(),
  }
  await query(
    `INSERT INTO \`api_sandbox_records\`
       (\`tenant_id\`, \`sandbox_id\`, \`resource_type\`, \`resource_code\`, \`data\`)
     VALUES (?, ?, 'client', ?, CAST(? AS JSON))`,
    [tenantId, sandboxId, record.client_code, JSON.stringify(record)],
  )
  return record
}

export async function listSandboxClients(
  tenantId: number,
  sandboxId: string,
  limit = 50,
  offset = 0,
): Promise<{ rows: SandboxClient[]; total: number }> {
  await ensureSchema()
  const rows = await query<any[]>(
    `SELECT \`data\` FROM \`api_sandbox_records\`
      WHERE \`tenant_id\` = ? AND \`sandbox_id\` = ? AND \`resource_type\` = 'client'
      ORDER BY \`created_at\` DESC, \`id\` DESC
      LIMIT ? OFFSET ?`,
    [tenantId, sandboxId, limit, offset],
  )
  const total = await countRecords(tenantId, sandboxId, "client")
  return { rows: rows.map((r) => parseData(r.data)), total }
}

function parseData(data: unknown): SandboxClient {
  if (typeof data === "string") return JSON.parse(data) as SandboxClient
  return data as SandboxClient
}
