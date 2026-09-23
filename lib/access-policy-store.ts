import "server-only"
/**
 * SPEC 63 — Access policy persistence + enforcement loader.
 * ---------------------------------------------------------------------------
 * Stores the tenant-defined conditional access policies edited in
 * components/security/access-policy-builder.tsx, and exposes both the CRUD the
 * admin API uses and the read path the login route uses to enforce them. The
 * decision logic itself lives in the pure lib/access-policy-core.ts so it can
 * be unit-tested without a database.
 *
 * Self-heals at runtime (same pattern as lib/session-store.ts /
 * lib/ip-allowlist-store.ts) so existing databases converge without a manual
 * migration step.
 */
import { query } from "@/lib/db"
import {
  type AccessPolicy,
  type PolicyCondition,
  type PolicyContext,
  type PolicyDecision,
  type PolicyEffect,
  POLICY_EFFECTS,
  evaluateAccessPolicies as evaluatePolicies,
} from "@/lib/access-policy-core"

type PolicyRow = {
  id: number
  tenant_id: number | null
  name: string
  priority: number
  scope: string
  combinator: "AND" | "OR"
  effect: string
  enabled: number
  conditions: string | null
  created_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`access_policies\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`name\` VARCHAR(160) NOT NULL,
      \`priority\` INT NOT NULL DEFAULT 100,
      \`scope\` VARCHAR(24) NOT NULL DEFAULT 'Tenant',
      \`combinator\` ENUM('AND','OR') NOT NULL DEFAULT 'AND',
      \`effect\` VARCHAR(32) NOT NULL DEFAULT 'Allow',
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
      \`conditions\` JSON DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_access_policies_tenant\` (\`tenant_id\`),
      KEY \`idx_access_policies_enabled\` (\`enabled\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

function parseConditions(raw: string | null): PolicyCondition[] {
  if (!raw) return []
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((c) => c && typeof c === "object")
      .map((c, i) => ({
        id: String((c as any).id ?? `c${i}`),
        field: String((c as any).field ?? ""),
        operator: String((c as any).operator ?? "="),
        value: String((c as any).value ?? ""),
      }))
  } catch {
    return []
  }
}

function toPublic(row: PolicyRow): AccessPolicy {
  return {
    id: String(row.id),
    name: row.name,
    priority: Number(row.priority),
    scope: row.scope,
    combinator: row.combinator === "OR" ? "OR" : "AND",
    effect: normalizeEffect(row.effect),
    enabled: Boolean(row.enabled),
    conditions: parseConditions(row.conditions),
  }
}

function normalizeEffect(effect: string): PolicyEffect {
  return (POLICY_EFFECTS as readonly string[]).includes(effect) ? (effect as PolicyEffect) : "Allow"
}

function sanitizeConditions(conditions: unknown): PolicyCondition[] {
  if (!Array.isArray(conditions)) return []
  return conditions
    .filter((c) => c && typeof c === "object")
    .map((c, i) => ({
      id: String((c as any).id ?? `c${i}`),
      field: String((c as any).field ?? "").slice(0, 40),
      operator: String((c as any).operator ?? "=").slice(0, 10),
      value: String((c as any).value ?? "").slice(0, 500),
    }))
}

export type AccessPolicyInput = {
  name: string
  priority: number
  scope: string
  combinator: "AND" | "OR"
  effect: string
  enabled: boolean
  conditions: unknown
}

function validateInput(input: AccessPolicyInput): { name: string; effect: PolicyEffect; conditions: PolicyCondition[] } {
  const name = String(input.name ?? "").trim()
  if (!name) throw new Error("Policy name is required")
  if (name.length > 160) throw new Error("Policy name is too long")
  const effect = normalizeEffect(String(input.effect))
  const conditions = sanitizeConditions(input.conditions)
  return { name, effect, conditions }
}

export async function listAccessPolicies(tenantId: number | null): Promise<AccessPolicy[]> {
  await ensureTable()
  const rows = await query<PolicyRow[]>(
    `SELECT * FROM access_policies WHERE tenant_id = ? OR tenant_id IS NULL ORDER BY priority ASC, id ASC`,
    [tenantId],
  )
  return rows.map(toPublic)
}

export async function createAccessPolicy(
  tenantId: number | null,
  createdBy: number,
  input: AccessPolicyInput,
): Promise<AccessPolicy> {
  await ensureTable()
  const { name, effect, conditions } = validateInput(input)
  const result = await query<{ insertId: number }>(
    `INSERT INTO access_policies (tenant_id, name, priority, scope, combinator, effect, enabled, conditions, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      name,
      Number.isFinite(input.priority) ? Math.trunc(input.priority) : 100,
      String(input.scope || "Tenant").slice(0, 24),
      input.combinator === "OR" ? "OR" : "AND",
      effect,
      input.enabled ? 1 : 0,
      JSON.stringify(conditions),
      createdBy,
    ],
  )
  const rows = await query<PolicyRow[]>(`SELECT * FROM access_policies WHERE id = ?`, [(result as any).insertId])
  return toPublic(rows[0])
}

export async function updateAccessPolicy(
  tenantId: number | null,
  id: number,
  input: AccessPolicyInput,
): Promise<AccessPolicy | null> {
  await ensureTable()
  const { name, effect, conditions } = validateInput(input)
  await query(
    `UPDATE access_policies
       SET name = ?, priority = ?, scope = ?, combinator = ?, effect = ?, enabled = ?, conditions = ?
     WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`,
    [
      name,
      Number.isFinite(input.priority) ? Math.trunc(input.priority) : 100,
      String(input.scope || "Tenant").slice(0, 24),
      input.combinator === "OR" ? "OR" : "AND",
      effect,
      input.enabled ? 1 : 0,
      JSON.stringify(conditions),
      id,
      tenantId,
    ],
  )
  const rows = await query<PolicyRow[]>(
    `SELECT * FROM access_policies WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`,
    [id, tenantId],
  )
  return rows[0] ? toPublic(rows[0]) : null
}

export async function deleteAccessPolicy(tenantId: number | null, id: number): Promise<void> {
  await ensureTable()
  await query(`DELETE FROM access_policies WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [id, tenantId])
}

/**
 * Load a tenant's enabled policies and evaluate them against the sign-in
 * context. Fails open (empty decision) on any store error so a policy-store
 * outage never blocks every sign-in — matching the platform's DB-degradation
 * posture elsewhere (see lib/session-store.ts).
 */
export async function evaluateAccessPolicies(
  tenantId: number | null,
  ctx: PolicyContext,
  now: Date = new Date(),
): Promise<PolicyDecision> {
  try {
    const policies = await listAccessPolicies(tenantId)
    return evaluatePolicies(policies, ctx, now)
  } catch (err) {
    console.error("[v0] access policy evaluation failed, failing open:", err)
    return { denied: false, deniedByPolicy: null, requireMfa: false, requireReauth: false, matched: [] }
  }
}
