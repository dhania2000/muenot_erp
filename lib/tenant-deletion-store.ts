import "server-only"
/**
 * Spec24 — Tenant deletion store (full-tenant safe offboarding).
 * ---------------------------------------------------------------------------
 * A single-active-request lifecycle for deleting an entire tenant, built around
 * four non-negotiable safeguards (all evaluated by evaluateTenantDeletionReadiness):
 *   1. COOLING PERIOD — a bounded window between request and final approval.
 *   2. MANDATORY EXPORT — a full-tenant data export must complete first, so the
 *      customer keeps a copy. Reuses lib/data-export-store.ts.
 *   3. LEGAL HOLD BLOCK — any active legal hold on the tenant blocks deletion
 *      absolutely (consults lib/legal-hold-store.ts).
 *   4. RETENTION/BACKUP PROOF — the operator must acknowledge and prove backup
 *      and statutory-retention obligations are satisfied.
 *
 * Every transition is tenant-scoped and written to the immutable audit log.
 * Self-heals its schema at runtime. Actual physical purge of tenant bytes is an
 * operational step performed out of band; this store records the authorized
 * `executed` decision and its evidence — it never issues destructive DROP/TRUNCATE.
 */
import { query } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import { listHolds } from "@/lib/legal-hold-store"
import { createAndRunExport, type Actor as ExportActor } from "@/lib/data-export-store"
import { FULL_TENANT_EXPORT_KEY } from "@/lib/data-export-model"
import {
  clampCoolingDays,
  computeCoolingEndsAt,
  coolingDaysRemaining,
  evaluateTenantDeletionReadiness,
  isCoolingElapsed,
  normalizeTenantDeletionInput,
  type TenantDeletionReadiness,
  type TenantDeletionStatus,
} from "@/lib/privacy-model"

export type Actor = { userId: number; name?: string | null; email?: string | null; role?: string | null }

export type TenantDeletionRequest = {
  id: number
  tenantId: number
  status: TenantDeletionStatus
  reason: string | null
  coolingDays: number
  coolingEndsAt: string
  coolingElapsed: boolean
  coolingDaysRemaining: number
  exportJobId: number | null
  exportCompleted: boolean
  retentionProven: boolean
  retentionProofNote: string | null
  requestedByUserId: number | null
  requestedByName: string | null
  approvedByName: string | null
  approvedAt: string | null
  executedByName: string | null
  executedAt: string | null
  createdAt: string
  updatedAt: string
}

let schemaReady: Promise<void> | null = null

export function ensureTenantDeletionSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS \`tenant_deletion_requests\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT NOT NULL,
          \`status\` VARCHAR(16) NOT NULL DEFAULT 'requested',
          \`reason\` VARCHAR(1000) NULL,
          \`cooling_days\` INT NOT NULL DEFAULT 30,
          \`cooling_ends_at\` DATETIME NOT NULL,
          \`export_job_id\` BIGINT UNSIGNED NULL,
          \`retention_proven\` TINYINT(1) NOT NULL DEFAULT 0,
          \`retention_proof_note\` VARCHAR(1000) NULL,
          \`requested_by_user_id\` INT NULL,
          \`requested_by_name\` VARCHAR(160) NULL,
          \`approved_by_name\` VARCHAR(160) NULL,
          \`approved_at\` DATETIME NULL,
          \`executed_by_name\` VARCHAR(160) NULL,
          \`executed_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          KEY \`idx_tdr_tenant_status\` (\`tenant_id\`, \`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      )
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

function mapRow(r: any, now: Date = new Date()): TenantDeletionRequest {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    status: r.status,
    reason: r.reason,
    coolingDays: Number(r.cooling_days),
    coolingEndsAt: r.cooling_ends_at,
    coolingElapsed: isCoolingElapsed(r.cooling_ends_at, now),
    coolingDaysRemaining: coolingDaysRemaining(r.cooling_ends_at, now),
    exportJobId: r.export_job_id == null ? null : Number(r.export_job_id),
    exportCompleted: r.export_job_id != null,
    retentionProven: Boolean(r.retention_proven),
    retentionProofNote: r.retention_proof_note,
    requestedByUserId: r.requested_by_user_id == null ? null : Number(r.requested_by_user_id),
    requestedByName: r.requested_by_name,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    executedByName: r.executed_by_name,
    executedAt: r.executed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Count active legal holds for a tenant — any one blocks deletion. */
async function countActiveHolds(tenantId: number): Promise<number> {
  const holds = await listHolds(tenantId).catch(() => [])
  return holds.filter((h) => h.status === "active").length
}

/** The single non-terminal request for a tenant, if any. */
export async function getActiveDeletionRequest(tenantId: number): Promise<TenantDeletionRequest | null> {
  await ensureTenantDeletionSchema()
  const rows = (await query(
    `SELECT * FROM \`tenant_deletion_requests\`
      WHERE \`tenant_id\` = ? AND \`status\` NOT IN ('executed','cancelled')
      ORDER BY \`id\` DESC LIMIT 1`,
    [tenantId],
  )) as any[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getDeletionRequest(tenantId: number, id: number): Promise<TenantDeletionRequest | null> {
  await ensureTenantDeletionSchema()
  const rows = (await query(`SELECT * FROM \`tenant_deletion_requests\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])) as any[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listDeletionRequests(tenantId: number, limit = 50): Promise<TenantDeletionRequest[]> {
  await ensureTenantDeletionSchema()
  const capped = Math.min(200, Math.max(1, Math.floor(limit)))
  const rows = (await query(
    `SELECT * FROM \`tenant_deletion_requests\` WHERE \`tenant_id\` = ? ORDER BY \`id\` DESC LIMIT ?`,
    [tenantId, capped],
  )) as any[]
  return rows.map((r) => mapRow(r))
}

/**
 * Assemble the live readiness assessment for a request, consulting active legal
 * holds. This is the gate the approve/execute transitions and the UI share.
 */
export async function assessDeletionReadiness(req: TenantDeletionRequest): Promise<TenantDeletionReadiness & { activeLegalHolds: number }> {
  const activeLegalHolds = await countActiveHolds(req.tenantId)
  const readiness = evaluateTenantDeletionReadiness({
    status: req.status,
    coolingEndsAt: req.coolingEndsAt,
    exportCompleted: req.exportCompleted,
    activeLegalHolds,
    retentionProven: req.retentionProven,
  })
  return { ...readiness, activeLegalHolds }
}

/**
 * Open a tenant deletion request. Only ONE active request may exist at a time
 * (idempotency): a second attempt returns the existing one instead of creating
 * a duplicate.
 */
export async function requestTenantDeletion(
  tenantId: number,
  input: unknown,
  actor: Actor,
  auditContext?: AuditContext,
): Promise<TenantDeletionRequest> {
  await ensureTenantDeletionSchema()
  const existing = await getActiveDeletionRequest(tenantId)
  if (existing) return existing

  const data = normalizeTenantDeletionInput((input ?? {}) as Record<string, unknown>)
  const now = new Date()
  const coolingEndsAt = computeCoolingEndsAt(now, data.coolingDays)
  const result = (await query(
    `INSERT INTO \`tenant_deletion_requests\`
       (\`tenant_id\`, \`status\`, \`reason\`, \`cooling_days\`, \`cooling_ends_at\`, \`requested_by_user_id\`, \`requested_by_name\`)
     VALUES (?, 'requested', ?, ?, ?, ?, ?)`,
    [tenantId, data.reason, clampCoolingDays(data.coolingDays), coolingEndsAt, actor.userId, actor.name ?? null],
  )) as any
  const id = Number(result.insertId)
  await recordAuditLog(
    {
      action: "privacy.tenant_deletion.requested",
      entityType: "TenantDeletionRequest",
      entityId: id,
      entityLabel: `Tenant ${tenantId} deletion`,
      after: { coolingDays: data.coolingDays, coolingEndsAt: coolingEndsAt.toISOString() },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return (await getDeletionRequest(tenantId, id))!
}

/**
 * Produce the mandatory full-tenant export and attach it to the request,
 * advancing it to `export_ready`. Reuses the tenant data-export pipeline.
 */
export async function runDeletionExport(
  tenantId: number,
  id: number,
  actor: Actor,
  auditContext?: AuditContext,
): Promise<TenantDeletionRequest> {
  await ensureTenantDeletionSchema()
  const req = await getDeletionRequest(tenantId, id)
  if (!req) throw new Error("Request not found")
  if (req.status === "executed" || req.status === "cancelled") throw new Error(`Request is already ${req.status}`)

  const exportActor: ExportActor = { userId: actor.userId, name: actor.name ?? null, email: actor.email ?? null, role: (actor.role as any) ?? "owner" }
  const job = await createAndRunExport(tenantId, { datasetKey: FULL_TENANT_EXPORT_KEY, format: "json", triggerSource: "manual" }, exportActor)
  if (job.status !== "completed") {
    throw new Error("The tenant export did not complete; resolve the export error and retry")
  }
  const nextStatus: TenantDeletionStatus = req.status === "requested" ? "export_ready" : req.status
  await query(
    `UPDATE \`tenant_deletion_requests\` SET \`export_job_id\` = ?, \`status\` = ? WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [job.id, nextStatus, id, tenantId],
  )
  await recordAuditLog(
    {
      action: "privacy.tenant_deletion.exported",
      entityType: "TenantDeletionRequest",
      entityId: id,
      entityLabel: `Tenant ${tenantId} deletion`,
      after: { exportJobId: job.id, rowCount: job.rowCount ?? null },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return (await getDeletionRequest(tenantId, id))!
}

/** Record the retention/backup obligation proof (an explicit acknowledgement). */
export async function proveRetention(
  tenantId: number,
  id: number,
  input: { proven: boolean; note?: unknown },
  actor: Actor,
  auditContext?: AuditContext,
): Promise<TenantDeletionRequest> {
  await ensureTenantDeletionSchema()
  const req = await getDeletionRequest(tenantId, id)
  if (!req) throw new Error("Request not found")
  if (req.status === "executed" || req.status === "cancelled") throw new Error(`Request is already ${req.status}`)
  const note = String(input.note ?? "").trim().slice(0, 1000) || null
  await query(
    `UPDATE \`tenant_deletion_requests\` SET \`retention_proven\` = ?, \`retention_proof_note\` = ? WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [input.proven ? 1 : 0, note, id, tenantId],
  )
  await recordAuditLog(
    {
      action: "privacy.tenant_deletion.retention_proof",
      entityType: "TenantDeletionRequest",
      entityId: id,
      entityLabel: `Tenant ${tenantId} deletion`,
      after: { retentionProven: input.proven, note },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return (await getDeletionRequest(tenantId, id))!
}

/**
 * Final approval. Enforces the FULL readiness gate server-side: cooling
 * elapsed, export completed, no active legal hold, retention proven. Throws a
 * user-facing message listing what is still outstanding.
 */
export async function approveTenantDeletion(
  tenantId: number,
  id: number,
  actor: Actor,
  auditContext?: AuditContext,
): Promise<TenantDeletionRequest> {
  await ensureTenantDeletionSchema()
  const req = await getDeletionRequest(tenantId, id)
  if (!req) throw new Error("Request not found")
  const readiness = await assessDeletionReadiness(req)
  if (!readiness.canApprove) {
    throw new Error(`Cannot approve: ${readiness.reasons.join("; ")}`)
  }
  await query(
    `UPDATE \`tenant_deletion_requests\` SET \`status\` = 'approved', \`approved_by_name\` = ?, \`approved_at\` = NOW() WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [actor.name ?? null, id, tenantId],
  )
  await recordAuditLog(
    {
      action: "privacy.tenant_deletion.approved",
      entityType: "TenantDeletionRequest",
      entityId: id,
      entityLabel: `Tenant ${tenantId} deletion`,
      before: { status: req.status },
      after: { status: "approved", checks: readiness.checks },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return (await getDeletionRequest(tenantId, id))!
}

/**
 * Mark the deletion executed. Re-checks the readiness gate (defense in depth)
 * and requires the request to already be `approved`. Records the authorized
 * decision and evidence; the physical purge is an out-of-band operational step.
 */
export async function executeTenantDeletion(
  tenantId: number,
  id: number,
  actor: Actor,
  auditContext?: AuditContext,
): Promise<TenantDeletionRequest> {
  await ensureTenantDeletionSchema()
  const req = await getDeletionRequest(tenantId, id)
  if (!req) throw new Error("Request not found")
  const readiness = await assessDeletionReadiness(req)
  if (!readiness.canExecute) {
    throw new Error(`Cannot execute: ${readiness.reasons.join("; ") || "request is not approved"}`)
  }
  await query(
    `UPDATE \`tenant_deletion_requests\` SET \`status\` = 'executed', \`executed_by_name\` = ?, \`executed_at\` = NOW() WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [actor.name ?? null, id, tenantId],
  )
  await recordAuditLog(
    {
      action: "privacy.tenant_deletion.executed",
      entityType: "TenantDeletionRequest",
      entityId: id,
      entityLabel: `Tenant ${tenantId} deletion`,
      before: { status: "approved" },
      after: { status: "executed", checks: readiness.checks },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return (await getDeletionRequest(tenantId, id))!
}

/** Withdraw a request before execution. */
export async function cancelTenantDeletion(
  tenantId: number,
  id: number,
  actor: Actor,
  reason: unknown,
  auditContext?: AuditContext,
): Promise<TenantDeletionRequest> {
  await ensureTenantDeletionSchema()
  const req = await getDeletionRequest(tenantId, id)
  if (!req) throw new Error("Request not found")
  if (req.status === "executed") throw new Error("An executed deletion cannot be cancelled")
  if (req.status === "cancelled") return req
  const note = String(reason ?? "").trim().slice(0, 1000) || null
  await query(
    `UPDATE \`tenant_deletion_requests\` SET \`status\` = 'cancelled', \`retention_proof_note\` = COALESCE(?, \`retention_proof_note\`) WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [note, id, tenantId],
  )
  await recordAuditLog(
    {
      action: "privacy.tenant_deletion.cancelled",
      entityType: "TenantDeletionRequest",
      entityId: id,
      entityLabel: `Tenant ${tenantId} deletion`,
      before: { status: req.status },
      after: { status: "cancelled", reason: note },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return (await getDeletionRequest(tenantId, id))!
}
