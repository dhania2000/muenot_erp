import "server-only"
import { query, tableColumns } from "@/lib/db"
import { getCurrentTenant } from "@/lib/tenant-context"
import { recordAuditLog } from "@/lib/audit-log-store"
import { scopeWhereForModule, mergeScopeIntoWhere } from "@/lib/permission-enforce"
import type { getSession } from "@/lib/auth"
import {
  ACTIVE_ALLOCATION_STATUSES,
  APPROVED_LEAVE_STATUSES,
  ResolutionError,
  allocationId,
  planResolution,
  type AllocationRow,
  type LeaveRow,
  type ResolutionInput,
} from "@/lib/resource-conflicts-model"

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>

const TABLE = "operations_allocation_resolutions"
let schemaReady: Promise<void> | null = null

function tenantId(): number | null {
  return getCurrentTenant()?.tenantId ?? null
}

export function ensureResolutionSchema(): Promise<void> {
  schemaReady ??= query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       tenant_id INT UNSIGNED DEFAULT NULL,
       conflict_key VARCHAR(500) NOT NULL,
       conflict_type VARCHAR(40) NOT NULL,
       action VARCHAR(30) NOT NULL,
       allocation_id VARCHAR(64) DEFAULT NULL,
       before_json JSON DEFAULT NULL,
       after_json JSON DEFAULT NULL,
       reason VARCHAR(500) DEFAULT NULL,
       idempotency_key VARCHAR(120) DEFAULT NULL,
       resolved_by INT UNSIGNED DEFAULT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       UNIQUE KEY uq_alloc_resolution_idem (tenant_id, idempotency_key),
       KEY idx_alloc_resolution_key (tenant_id, conflict_key(191))
     )`,
  )
    .then(() => undefined)
    .catch((error) => {
      schemaReady = null
      throw error
    })
  return schemaReady
}

async function tenantClause(table: string): Promise<{ sql: string; args: unknown[] }> {
  const cols = await tableColumns(table)
  return cols.has("tenant_id") ? { sql: "(tenant_id <=> ?)", args: [tenantId()] } : { sql: "", args: [] }
}

/** Active allocations (permission-scoped + tenant-scoped) and approved leaves for the tenant. */
export async function loadConflictData(session: Session): Promise<{ allocations: AllocationRow[]; leaves: LeaveRow[] }> {
  const scoped = await scopeWhereForModule(session, "operations.allocations", "view", "operations_allocations")
  const { where, args } = mergeScopeIntoWhere("", [], scoped)
  const conds: string[] = where ? [where.replace(/^\s*WHERE\s+/i, "")] : []
  const params: unknown[] = [...args]
  const allocTenant = await tenantClause("operations_allocations")
  if (allocTenant.sql) {
    conds.push(allocTenant.sql)
    params.push(...allocTenant.args)
  }
  conds.push(`status IN (${ACTIVE_ALLOCATION_STATUSES.map(() => "?").join(",")})`)
  params.push(...ACTIVE_ALLOCATION_STATUSES)
  const allocations = await query<AllocationRow[]>(
    `SELECT * FROM operations_allocations WHERE ${conds.join(" AND ")}`,
    params,
  )

  const leaveTenant = await tenantClause("hr_leave_requests")
  const leaveConds = [`status IN (${APPROVED_LEAVE_STATUSES.map(() => "?").join(",")})`]
  const leaveArgs: unknown[] = [...APPROVED_LEAVE_STATUSES]
  if (leaveTenant.sql) {
    leaveConds.push(leaveTenant.sql)
    leaveArgs.push(...leaveTenant.args)
  }
  const leaves = await query<LeaveRow[]>(
    `SELECT employee_id, employee_name, from_date, to_date, status FROM hr_leave_requests WHERE ${leaveConds.join(" AND ")}`,
    leaveArgs,
  ).catch(() => [] as LeaveRow[])
  return { allocations, leaves }
}

/** Conflict keys the tenant has explicitly accepted (acknowledged as intentional). */
export async function acceptedConflictKeys(): Promise<Set<string>> {
  await ensureResolutionSchema()
  const rows = await query<Array<{ conflict_key: string }>>(
    `SELECT DISTINCT conflict_key FROM ${TABLE} WHERE (tenant_id <=> ?) AND action = 'accept'`,
    [tenantId()],
  )
  return new Set(rows.map((r) => r.conflict_key))
}

export async function listResolutions(limit = 50) {
  await ensureResolutionSchema()
  return query<any[]>(
    `SELECT id, conflict_key, conflict_type, action, allocation_id, before_json, after_json, reason, resolved_by, created_at
       FROM ${TABLE} WHERE (tenant_id <=> ?) ORDER BY id DESC LIMIT ?`,
    [tenantId(), Math.min(Math.max(1, limit), 200)],
  )
}

/**
 * Resolve one conflict. Idempotent per (tenant, idempotency_key); the
 * allocation update is guarded by its previous values so a concurrent edit
 * surfaces as 409 instead of being silently overwritten.
 */
export async function resolveConflict(
  session: Session,
  input: ResolutionInput,
  idempotencyKey: string | null,
): Promise<{ resolution: any; replayed: boolean }> {
  await ensureResolutionSchema()
  const tid = tenantId()
  const idem = idempotencyKey ? idempotencyKey.slice(0, 120) : null

  if (idem) {
    const existing = await query<any[]>(
      `SELECT * FROM ${TABLE} WHERE (tenant_id <=> ?) AND idempotency_key = ? LIMIT 1`,
      [tid, idem],
    )
    if (existing[0]) return { resolution: existing[0], replayed: true }
  }

  const { allocations, leaves } = await loadConflictData(session)
  const { conflict, target, patch } = planResolution(input, allocations, leaves)

  let before: Record<string, unknown> | null = null
  if (target) {
    const fields = Object.keys(patch) as Array<keyof typeof patch>
    before = Object.fromEntries(fields.map((f) => [f, target[f] ?? null]))
    const tenant = await tenantClause("operations_allocations")
    const sets = fields.map((f) => `${f} = ?`).join(", ")
    const guards = fields.map((f) => `${f} <=> ?`)
    const result = await query<{ affectedRows?: number }>(
      `UPDATE operations_allocations SET ${sets}
        WHERE id = ? ${tenant.sql ? `AND ${tenant.sql}` : ""} AND ${guards.join(" AND ")}`,
      [...fields.map((f) => patch[f] ?? null), allocationId(target), ...tenant.args, ...fields.map((f) => target[f] ?? null)],
    )
    if (!result?.affectedRows) throw new ResolutionError("Allocation changed since it was loaded; refresh and retry", 409)
  }

  const insert = await query<{ insertId?: number }>(
    `INSERT INTO ${TABLE} (tenant_id, conflict_key, conflict_type, action, allocation_id, before_json, after_json, reason, idempotency_key, resolved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tid,
      conflict.key,
      conflict.type,
      input.action,
      target ? allocationId(target) : null,
      before ? JSON.stringify(before) : null,
      target ? JSON.stringify(patch) : null,
      input.reason ?? null,
      idem,
      session.userId ?? null,
    ],
  )

  await recordAuditLog({
    action: "operations.allocation_conflict.resolve",
    entityType: "operations_allocation",
    entityId: target ? allocationId(target) : null,
    entityLabel: conflict.message,
    before,
    after: target ? (patch as Record<string, unknown>) : null,
    metadata: { conflict_key: conflict.key, conflict_type: conflict.type, action: input.action, reason: input.reason ?? null },
  })

  return {
    resolution: {
      id: insert?.insertId ?? null,
      conflict_key: conflict.key,
      conflict_type: conflict.type,
      action: input.action,
      allocation_id: target ? allocationId(target) : null,
      before,
      after: target ? patch : null,
    },
    replayed: false,
  }
}
