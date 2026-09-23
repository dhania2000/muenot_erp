import "server-only"
import { query } from "./db"
import { requireCurrentTenantId } from "./tenant-context"
import { raiseApprovalRequest, actOnApprovalRequest } from "./approval-authority"
import {
  getOperation,
  listOperations,
  defaultGateState,
  type MakerCheckerOperation,
} from "./maker-checker-registry"
import { decideOutcome, type ChangeStatus } from "./maker-checker-core"

// =============================================================================
// Maker-Checker · Phase 2: the framework.
// -----------------------------------------------------------------------------
// Business modules don't approve anything themselves. When a high-risk
// operation (see maker-checker-registry.ts) is attempted, the module hands the
// intended change here as an inert, serialisable payload. This module:
//
//   1. Persists the intended change (status `pending`) — nothing is applied.
// 2. Raises an approval request on the engine using the operation's
//      module key, so the *existing* rule/level/delegation/escalation machinery
//      decides who the checker is.
//   3. Only when a checker approves (segregation enforced in the engine) does
//      `handleApprovalOutcome` run the registered applier that actually mutates
//      the business data.
//
// Bypass prevention: the underlying mutation is NEVER called on the maker's
// request. It is called exactly once, later, from the approval outcome, and
// only for an `approved` request (see maker-checker-core.decideOutcome).
//
// Tenant-scoped like the rest of the app: every read/write filters by the
// verified session tenant, never client input.
// =============================================================================

let schemaEnsured: Promise<void> | null = null

export function ensureMakerCheckerSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = runEnsure().catch((err) => {
      schemaEnsured = null
      throw err
    })
  }
  return schemaEnsured
}

async function runEnsure(): Promise<void> {
  // Per-tenant on/off switch for each governed operation. Absence of a row
  // means "use the registry default".
  await query(
    `CREATE TABLE IF NOT EXISTS maker_checker_settings (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      operation_key VARCHAR(80) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_by INT UNSIGNED DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_mcs_tenant_op (tenant_id, operation_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // The captured intent of a high-risk change, held until a checker decides.
  await query(
    `CREATE TABLE IF NOT EXISTS maker_checker_changes (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      operation_key VARCHAR(80) NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      entity_type VARCHAR(80) DEFAULT NULL,
      entity_pk INT UNSIGNED DEFAULT NULL,
      entity_ref VARCHAR(190) DEFAULT NULL,
      title VARCHAR(255) DEFAULT NULL,
      amount DECIMAL(18,2) DEFAULT NULL,
      payload LONGTEXT NOT NULL,
      status ENUM('pending','approved','applied','auto_applied','rejected','cancelled','failed')
        NOT NULL DEFAULT 'pending',
      approval_request_id INT UNSIGNED DEFAULT NULL,
      maker_id INT UNSIGNED DEFAULT NULL,
      maker_name VARCHAR(190) DEFAULT NULL,
      apply_error VARCHAR(500) DEFAULT NULL,
      result_ref VARCHAR(190) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      applied_at TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_mcc_tenant_status (tenant_id, status),
      KEY idx_mcc_request (approval_request_id),
      KEY idx_mcc_entity (tenant_id, entity_type, entity_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
}

// ---------------------------------------------------------------------------
// Applier registry
// ---------------------------------------------------------------------------
// An applier is the function that performs the real mutation once a change is
// approved. It receives the payload the maker captured plus who is applying it.
// Appliers are registered in module scope (see maker-checker-appliers.ts) and
// looked up by operation key at apply time, so nothing about the deferred
// mutation is stored as a closure — only serialisable data lives in the DB.

export type ApplyContext = {
  changeId: number
  operationKey: string
  /** The maker who prepared the change (preserved as the record's author). */
  makerId: number | null
  makerName: string | null
}

export type ApplyResult = {
  /** A short human/business reference for the created/updated record, if any. */
  ref?: string | null
}

export type Applier = (payload: any, ctx: ApplyContext) => Promise<ApplyResult | void>

const appliers = new Map<string, Applier>()

/** Register the mutation that runs when the named operation is approved. */
export function registerApplier(operationKey: string, fn: Applier): void {
  appliers.set(operationKey, fn)
}

// Appliers self-register on import. Loaded lazily (and memoised) so this module
// has no static dependency on the business services — avoiding import cycles
// and keeping the framework independent of any single module.
let appliersLoaded: Promise<void> | null = null
function ensureAppliersLoaded(): Promise<void> {
  if (!appliersLoaded) {
    appliersLoaded = import("./maker-checker-appliers").then(() => undefined)
  }
  return appliersLoaded
}

// ---------------------------------------------------------------------------
// Gate configuration
// ---------------------------------------------------------------------------

export type OperationGate = MakerCheckerOperation & { enabled: boolean }

/** Effective on/off state of every governed operation for the current tenant. */
export async function getOperationGates(): Promise<OperationGate[]> {
  await ensureMakerCheckerSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT operation_key, enabled FROM maker_checker_settings WHERE tenant_id = ?`,
    [tenantId],
  )
  const overrides = new Map<string, boolean>(rows.map((r) => [String(r.operation_key), Boolean(r.enabled)]))
  const defaults = defaultGateState()
  return listOperations().map((op) => ({
    ...op,
    enabled: overrides.has(op.key) ? Boolean(overrides.get(op.key)) : defaults[op.key],
  }))
}

/** Whether a specific operation is gated (requires maker-checker) right now. */
export async function isOperationGated(operationKey: string): Promise<boolean> {
  const op = getOperation(operationKey)
  if (!op) return false
  await ensureMakerCheckerSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT enabled FROM maker_checker_settings WHERE tenant_id = ? AND operation_key = ? LIMIT 1`,
    [tenantId, operationKey],
  )
  if (rows.length) return Boolean(rows[0].enabled)
  return op.defaultEnabled
}

/** Admin toggle for a single operation. */
export async function setOperationGate(operationKey: string, enabled: boolean, updatedBy: number | null): Promise<void> {
  if (!getOperation(operationKey)) throw new Error(`Unknown maker-checker operation: ${operationKey}`)
  await ensureMakerCheckerSchema()
  const tenantId = requireCurrentTenantId()
  await query(
    `INSERT INTO maker_checker_settings (tenant_id, operation_key, enabled, updated_by)
       VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by = VALUES(updated_by)`,
    [tenantId, operationKey, enabled ? 1 : 0, updatedBy],
  )
}

// ---------------------------------------------------------------------------
// Submitting a change for approval
// ---------------------------------------------------------------------------

export type SubmitInput = {
  operationKey: string
  payload: unknown
  maker: { userId: number; name?: string | null; role?: string | null }
  entityType?: string | null
  entityPk?: number | null
  entityRef?: string | null
  title?: string | null
  amount?: number | null
  department?: string | null
  legalEntityId?: number | null
}

export type SubmitResult = {
  gated: true
  changeId: number
  requestId: number
  /** True when the change already took effect (auto-applied, no rule matched). */
  applied: boolean
  /** True while awaiting a checker. */
  pending: boolean
  status: ChangeStatus
  /** Business reference of the applied record, when auto-applied. */
  ref?: string | null
}

/**
 * Capture a high-risk change and route it through approval. Nothing in the
 * business domain is mutated here — the payload is stored and an approval
 * request is raised. If no approval rule matches, the engine reports
 * `autoApproved`, and we apply immediately (there is no configured authority to
 * hold it), recording the change as `auto_applied`.
 *
 * Callers should only invoke this after confirming {@link isOperationGated}.
 */
export async function submitForApproval(input: SubmitInput): Promise<SubmitResult> {
  const op = getOperation(input.operationKey)
  if (!op) throw new Error(`Unknown maker-checker operation: ${input.operationKey}`)
  await ensureMakerCheckerSchema()
  const tenantId = requireCurrentTenantId()

  const ins = await query<any>(
    `INSERT INTO maker_checker_changes
      (tenant_id, operation_key, module_key, entity_type, entity_pk, entity_ref, title, amount, payload,
       status, maker_id, maker_name)
     VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    [
      tenantId,
      op.key,
      op.moduleKey,
      input.entityType ?? null,
      input.entityPk ?? null,
      input.entityRef ?? null,
      input.title ?? op.label,
      input.amount ?? null,
      JSON.stringify(input.payload ?? null),
      input.maker.userId,
      input.maker.name ?? null,
    ],
  )
  const changeId = Number(ins.insertId)

  const raise = await raiseApprovalRequest({
    moduleKey: op.moduleKey,
    entityType: input.entityType ?? "maker_checker_change",
    entityPk: changeId,
    entityRef: input.entityRef ?? null,
    title: input.title ?? op.label,
    amount: input.amount ?? null,
    department: input.department ?? null,
    requesterRole: input.maker.role ?? null,
    legalEntityId: input.legalEntityId ?? null,
    requestedBy: input.maker.userId,
    requestedByName: input.maker.name ?? null,
  })

  await query(`UPDATE maker_checker_changes SET approval_request_id = ? WHERE id = ? AND tenant_id = ?`, [
    raise.requestId,
    changeId,
    tenantId,
  ])

  if (raise.autoApproved) {
    const applied = await applyChange(changeId, { status: "auto_applied" })
    return {
      gated: true,
      changeId,
      requestId: raise.requestId,
      applied: applied.ok,
      pending: false,
      status: applied.ok ? "auto_applied" : "failed",
      ref: applied.ref ?? null,
    }
  }

  return { gated: true, changeId, requestId: raise.requestId, applied: false, pending: true, status: "pending" }
}

// ---------------------------------------------------------------------------
// Applying / resolving a change
// ---------------------------------------------------------------------------

type ApplyOutcome = { ok: boolean; ref?: string | null; error?: string }

/**
 * Run the registered applier for a captured change and record the result. Set
 * `status` to the terminal status to record on success (`applied` after an
 * approval, `auto_applied` when no rule matched). Idempotent: a change that is
 * no longer `pending` is left untouched.
 */
async function applyChange(changeId: number, opts: { status: "applied" | "auto_applied" }): Promise<ApplyOutcome> {
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT * FROM maker_checker_changes WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [changeId, tenantId],
  )
  if (!rows.length) return { ok: false, error: "Change not found" }
  const row = rows[0]
  if (String(row.status) !== "pending") return { ok: true, ref: row.result_ref ?? null }

  await ensureAppliersLoaded()
  const applier = appliers.get(String(row.operation_key))
  if (!applier) {
    await query(
      `UPDATE maker_checker_changes SET status = 'failed', apply_error = ? WHERE id = ? AND tenant_id = ?`,
      [`No applier registered for ${row.operation_key}`, changeId, tenantId],
    )
    return { ok: false, error: `No applier registered for ${row.operation_key}` }
  }

  let payload: any = null
  try {
    payload = row.payload ? JSON.parse(row.payload) : null
  } catch {
    payload = null
  }

  try {
    const res = await applier(payload, {
      changeId,
      operationKey: String(row.operation_key),
      makerId: row.maker_id != null ? Number(row.maker_id) : null,
      makerName: row.maker_name ?? null,
    })
    const ref = (res && "ref" in res ? res.ref : null) ?? null
    await query(
      `UPDATE maker_checker_changes SET status = ?, result_ref = ?, apply_error = NULL, applied_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [opts.status, ref, new Date(), changeId, tenantId],
    )
    return { ok: true, ref }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Apply failed"
    await query(
      `UPDATE maker_checker_changes SET status = 'failed', apply_error = ? WHERE id = ? AND tenant_id = ?`,
      [msg.slice(0, 500), changeId, tenantId],
    )
    return { ok: false, error: msg }
  }
}

/**
 * React to an approval request reaching a terminal state. Called from the
 * approvals action route after every approve/reject/cancel. Finds the captured
 * change bound to the request and, per the pure {@link decideOutcome} gate,
 * either applies it (approved) or discards it (rejected/cancelled). A `pending`
 * request is a no-op. Safe to call more than once.
 */
export async function handleApprovalOutcome(
  requestId: number,
  requestStatus: "pending" | "approved" | "rejected" | "cancelled",
): Promise<void> {
  await ensureMakerCheckerSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT * FROM maker_checker_changes WHERE approval_request_id = ? AND tenant_id = ? LIMIT 1`,
    [requestId, tenantId],
  )
  if (!rows.length) return
  const row = rows[0]
  const decision = decideOutcome(requestStatus, String(row.status) as ChangeStatus)

  if (decision.apply) {
    await applyChange(Number(row.id), { status: "applied" })
    return
  }
  if (decision.nextStatus && decision.nextStatus !== String(row.status)) {
    await query(`UPDATE maker_checker_changes SET status = ? WHERE id = ? AND tenant_id = ?`, [
      decision.nextStatus,
      Number(row.id),
      tenantId,
    ])
  }
}

// ---------------------------------------------------------------------------
// Reads for the admin console
// ---------------------------------------------------------------------------

export type MakerCheckerChange = {
  id: number
  operationKey: string
  operationLabel: string
  moduleKey: string
  title: string | null
  amount: number | null
  entityRef: string | null
  status: ChangeStatus
  approvalRequestId: number | null
  makerId: number | null
  makerName: string | null
  applyError: string | null
  resultRef: string | null
  createdAt: string
  appliedAt: string | null
}

function mapChange(r: any): MakerCheckerChange {
  return {
    id: Number(r.id),
    operationKey: String(r.operation_key),
    operationLabel: getOperation(String(r.operation_key))?.label ?? String(r.operation_key),
    moduleKey: String(r.module_key),
    title: r.title ?? null,
    amount: r.amount != null ? Number(r.amount) : null,
    entityRef: r.entity_ref ?? null,
    status: String(r.status) as ChangeStatus,
    approvalRequestId: r.approval_request_id != null ? Number(r.approval_request_id) : null,
    makerId: r.maker_id != null ? Number(r.maker_id) : null,
    makerName: r.maker_name ?? null,
    applyError: r.apply_error ?? null,
    resultRef: r.result_ref ?? null,
    createdAt: r.created_at,
    appliedAt: r.applied_at ?? null,
  }
}

/** Recent captured changes for the current tenant (newest first). */
export async function listChanges(filter?: { status?: ChangeStatus }): Promise<MakerCheckerChange[]> {
  await ensureMakerCheckerSchema()
  const tenantId = requireCurrentTenantId()
  const where: string[] = ["tenant_id = ?"]
  const params: any[] = [tenantId]
  if (filter?.status) {
    where.push("status = ?")
    params.push(filter.status)
  }
  const rows = await query<any[]>(
    `SELECT * FROM maker_checker_changes WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 200`,
    params,
  )
  return rows.map(mapChange)
}

// Re-export so a single import surfaces the framework + its guarantees.
export { actOnApprovalRequest }
export type { ChangeStatus } from "./maker-checker-core"
