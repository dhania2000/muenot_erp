import "server-only"
/**
 * Production sandbox & change-approval store (tenant-scoped).
 * ---------------------------------------------------------------------------
 * Every read/write is bound to the current tenant via lib/tenant-scope helpers
 * (which stamp / AND `tenant_id` for us), so one tenant can never see or mutate
 * another's sandbox environment, change requests, or audit trail. Registered in
 * lib/tenant-tables.ts so the fail-closed data-layer guard also protects these
 * tables against an accidental unscoped query.
 *
 * Self-heals its schema at runtime (same pattern as the rest of the codebase);
 * a matching SQL migration is shipped for fresh installs.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import {
  tenantFindById,
  tenantInsert,
  tenantSelect,
  tenantUpdate,
} from "@/lib/tenant-scope"
import {
  toChangeStatus,
  toDeployStatus,
  type ChangeStatus,
  type ConfigDiffEntry,
  type ConfigMap,
  type DeployStatus,
  type SandboxStatus,
} from "./model"

const ENV_TABLE = "sandbox_environments"
const CHANGE_TABLE = "sandbox_change_requests"
const AUDIT_TABLE = "sandbox_change_audit"

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`${ENV_TABLE}\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`status\` ENUM('inactive','active') NOT NULL DEFAULT 'inactive',
      \`db_schema\` VARCHAR(64) DEFAULT NULL,
      \`connection_ref\` VARCHAR(190) DEFAULT NULL,
      \`region\` VARCHAR(40) DEFAULT NULL,
      \`sanitized_config\` JSON DEFAULT NULL,
      \`last_copy_at\` DATETIME DEFAULT NULL,
      \`last_copy_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_sandbox_tenant\` (\`tenant_id\`),
      CONSTRAINT \`fk_sandbox_env_tenant\` FOREIGN KEY (\`tenant_id\`)
        REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`${CHANGE_TABLE}\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`title\` VARCHAR(200) NOT NULL,
      \`module_key\` VARCHAR(64) NOT NULL DEFAULT 'platform.config_change',
      \`status\` ENUM('draft','pending_approval','approved','rejected','promoted','rolled_back','cancelled')
          NOT NULL DEFAULT 'draft',
      \`deploy_status\` ENUM('not_deployed','deploying','deployed','failed','rolled_back')
          NOT NULL DEFAULT 'not_deployed',
      \`proposed\` JSON NOT NULL,
      \`diff\` JSON NOT NULL,
      \`rollback_snapshot\` JSON DEFAULT NULL,
      \`baseline_hash\` VARCHAR(32) DEFAULT NULL,
      \`approved_baseline_hash\` VARCHAR(32) DEFAULT NULL,
      \`approval_request_id\` INT UNSIGNED DEFAULT NULL,
      \`approval_status\` VARCHAR(20) DEFAULT NULL,
      \`approver_user_id\` INT UNSIGNED DEFAULT NULL,
      \`approver_name\` VARCHAR(190) DEFAULT NULL,
      \`decided_at\` DATETIME DEFAULT NULL,
      \`promoted_at\` DATETIME DEFAULT NULL,
      \`promoted_by\` INT UNSIGNED DEFAULT NULL,
      \`rolled_back_at\` DATETIME DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_by_name\` VARCHAR(190) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_sandbox_change_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_sandbox_change_status\` (\`tenant_id\`, \`status\`),
      CONSTRAINT \`fk_sandbox_change_tenant\` FOREIGN KEY (\`tenant_id\`)
        REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`${AUDIT_TABLE}\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`change_id\` INT UNSIGNED DEFAULT NULL,
      \`action\` VARCHAR(48) NOT NULL,
      \`detail\` JSON DEFAULT NULL,
      \`idempotency_key\` VARCHAR(128) DEFAULT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_email\` VARCHAR(190) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_sandbox_audit_tenant\` (\`tenant_id\`, \`created_at\`),
      UNIQUE KEY \`uniq_sandbox_idem\` (\`tenant_id\`, \`action\`, \`idempotency_key\`),
      CONSTRAINT \`fk_sandbox_audit_tenant\` FOREIGN KEY (\`tenant_id\`)
        REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureSandboxSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((err) => { ensured = null; throw err })
  return ensured
}

// ---------------------------------------------------------------------------
// Types + mapping
// ---------------------------------------------------------------------------

export type SandboxEnvironment = {
  tenantId: number
  status: SandboxStatus
  schema: string | null
  connectionRef: string | null
  region: string | null
  sanitizedConfig: ConfigMap | null
  lastCopyAt: string | null
  lastCopyBy: number | null
  createdAt: string | null
  updatedAt: string | null
}

export type SandboxChangeRecord = {
  id: number
  tenantId: number
  title: string
  moduleKey: string
  status: ChangeStatus
  deployStatus: DeployStatus
  proposed: ConfigMap
  diff: ConfigDiffEntry[]
  rollbackSnapshot: ConfigMap | null
  baselineHash: string | null
  approvedBaselineHash: string | null
  approvalRequestId: number | null
  approvalStatus: string | null
  approverUserId: number | null
  approverName: string | null
  decidedAt: string | null
  promotedAt: string | null
  promotedBy: number | null
  rolledBackAt: string | null
  createdBy: number | null
  createdByName: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type SandboxAuditEntry = {
  id: number
  changeId: number | null
  action: string
  detail: Record<string, unknown> | null
  actorUserId: number | null
  actorEmail: string | null
  createdAt: string
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

function mapEnv(row: any): SandboxEnvironment {
  return {
    tenantId: Number(row.tenant_id),
    status: (row.status as SandboxStatus) ?? "inactive",
    schema: row.db_schema ?? null,
    connectionRef: row.connection_ref ?? null,
    region: row.region ?? null,
    sanitizedConfig: parseJson<ConfigMap | null>(row.sanitized_config, null),
    lastCopyAt: row.last_copy_at ?? null,
    lastCopyBy: row.last_copy_by != null ? Number(row.last_copy_by) : null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function mapChange(row: any): SandboxChangeRecord {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    title: String(row.title),
    moduleKey: String(row.module_key),
    status: toChangeStatus(row.status),
    deployStatus: toDeployStatus(row.deploy_status),
    proposed: parseJson<ConfigMap>(row.proposed, {}),
    diff: parseJson<ConfigDiffEntry[]>(row.diff, []),
    rollbackSnapshot: parseJson<ConfigMap | null>(row.rollback_snapshot, null),
    baselineHash: row.baseline_hash ?? null,
    approvedBaselineHash: row.approved_baseline_hash ?? null,
    approvalRequestId: row.approval_request_id != null ? Number(row.approval_request_id) : null,
    approvalStatus: row.approval_status ?? null,
    approverUserId: row.approver_user_id != null ? Number(row.approver_user_id) : null,
    approverName: row.approver_name ?? null,
    decidedAt: row.decided_at ?? null,
    promotedAt: row.promoted_at ?? null,
    promotedBy: row.promoted_by != null ? Number(row.promoted_by) : null,
    rolledBackAt: row.rolled_back_at ?? null,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

// ---------------------------------------------------------------------------
// Sandbox environment
// ---------------------------------------------------------------------------

export async function getSandboxEnvironment(): Promise<SandboxEnvironment | null> {
  await ensureSandboxSchema()
  const rows = await tenantSelect<any[]>(ENV_TABLE, { tail: "LIMIT 1" })
  return rows[0] ? mapEnv(rows[0]) : null
}

export async function upsertSandboxEnvironment(input: {
  status?: SandboxStatus
  schema?: string | null
  connectionRef?: string | null
  region?: string | null
}): Promise<SandboxEnvironment> {
  await ensureSandboxSchema()
  const existing = await getSandboxEnvironment()
  if (!existing) {
    await tenantInsert(ENV_TABLE, {
      status: input.status ?? "active",
      db_schema: input.schema ?? null,
      connection_ref: input.connectionRef ?? null,
      region: input.region ?? null,
    })
  } else {
    const set: Record<string, any> = {}
    if (input.status !== undefined) set.status = input.status
    if (input.schema !== undefined) set.db_schema = input.schema
    if (input.connectionRef !== undefined) set.connection_ref = input.connectionRef
    if (input.region !== undefined) set.region = input.region
    if (Object.keys(set).length > 0) {
      await tenantUpdate(ENV_TABLE, set, "`tenant_id` = ?", [requireCurrentTenantId()])
    }
  }
  const env = await getSandboxEnvironment()
  if (!env) throw new Error("Failed to load sandbox environment")
  return env
}

export async function recordSandboxCopy(sanitized: ConfigMap, actorUserId: number): Promise<void> {
  await ensureSandboxSchema()
  await tenantUpdate(
    ENV_TABLE,
    {
      sanitized_config: JSON.stringify(sanitized),
      last_copy_at: new Date(),
      last_copy_by: actorUserId,
      status: "active",
    },
    "`tenant_id` = ?",
    [requireCurrentTenantId()],
  )
}

// ---------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------

export async function createChangeRow(input: {
  title: string
  moduleKey: string
  proposed: ConfigMap
  diff: ConfigDiffEntry[]
  baselineHash: string
  createdBy: number
  createdByName: string | null
}): Promise<SandboxChangeRecord> {
  await ensureSandboxSchema()
  const { insertId } = await tenantInsert(CHANGE_TABLE, {
    title: input.title,
    module_key: input.moduleKey,
    status: "draft",
    deploy_status: "not_deployed",
    proposed: JSON.stringify(input.proposed),
    diff: JSON.stringify(input.diff),
    baseline_hash: input.baselineHash,
    created_by: input.createdBy,
    created_by_name: input.createdByName,
  })
  const row = await getChangeById(insertId)
  if (!row) throw new Error("Failed to load created change request")
  return row
}

export async function getChangeById(id: number): Promise<SandboxChangeRecord | null> {
  await ensureSandboxSchema()
  const row = await tenantFindById<any>(CHANGE_TABLE, id)
  return row ? mapChange(row) : null
}

export async function updateChangeRow(id: number, set: Record<string, any>): Promise<void> {
  await ensureSandboxSchema()
  await tenantUpdate(CHANGE_TABLE, set, "`id` = ?", [id])
}

export async function listChanges(limit = 100): Promise<SandboxChangeRecord[]> {
  await ensureSandboxSchema()
  const safe = Math.min(500, Math.max(1, Math.floor(limit)))
  const rows = await tenantSelect<any[]>(CHANGE_TABLE, { tail: `ORDER BY id DESC LIMIT ${safe}` })
  return rows.map(mapChange)
}

// ---------------------------------------------------------------------------
// Audit + idempotency
// ---------------------------------------------------------------------------

/**
 * Append a sandbox audit row. When an idempotency key is supplied, the unique
 * (tenant, action, key) index makes a replayed action a no-op: `inserted:false`
 * signals the action already ran under this key.
 */
export async function recordSandboxAudit(entry: {
  changeId?: number | null
  action: string
  detail?: Record<string, unknown> | null
  idempotencyKey?: string | null
  actorUserId?: number | null
  actorEmail?: string | null
}): Promise<{ inserted: boolean }> {
  await ensureSandboxSchema()
  const tenantId = requireCurrentTenantId()
  const res = await query<any>(
    `INSERT INTO \`${AUDIT_TABLE}\` (\`tenant_id\`, \`change_id\`, \`action\`, \`detail\`, \`idempotency_key\`, \`actor_user_id\`, \`actor_email\`)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE \`id\` = \`id\``,
    [
      tenantId,
      entry.changeId ?? null,
      entry.action,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.idempotencyKey ?? null,
      entry.actorUserId ?? null,
      entry.actorEmail ?? null,
    ],
  )
  return { inserted: Number(res?.affectedRows ?? 0) === 1 }
}

/** Whether an action already ran under this idempotency key for this tenant. */
export async function isDuplicateSandboxAction(action: string, idempotencyKey: string): Promise<boolean> {
  await ensureSandboxSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT 1 FROM \`${AUDIT_TABLE}\` WHERE \`tenant_id\` = ? AND \`action\` = ? AND \`idempotency_key\` = ? LIMIT 1`,
    [tenantId, action, idempotencyKey],
  )
  return rows.length > 0
}

export async function listSandboxAudit(limit = 50): Promise<SandboxAuditEntry[]> {
  await ensureSandboxSchema()
  const safe = Math.min(200, Math.max(1, Math.floor(limit)))
  const rows = await tenantSelect<any[]>(AUDIT_TABLE, { tail: `ORDER BY id DESC LIMIT ${safe}` })
  return rows.map((r) => ({
    id: Number(r.id),
    changeId: r.change_id != null ? Number(r.change_id) : null,
    action: String(r.action),
    detail: parseJson<Record<string, unknown> | null>(r.detail, null),
    actorUserId: r.actor_user_id != null ? Number(r.actor_user_id) : null,
    actorEmail: r.actor_email ?? null,
    createdAt: r.created_at,
  }))
}
