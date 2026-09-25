import "server-only"
/**
 * Production sandbox & configuration change approval — orchestration.
 * ---------------------------------------------------------------------------
 * Ties together the pure domain core (model.ts), the tenant-scoped store
 * (store.ts) and the EXISTING subsystems this feature deliberately reuses
 * rather than duplicating:
 *
 *   - Tenant deployment settings  : lib/tenant-db/model connection validation.
 *   - Config layer                : lib/tenant-settings (production source of
 *                                   truth; the promotion target + rollback).
 *   - Secret inventory / redaction: lib/sandbox/model (built on lib/secrets).
 *   - Approval engine             : lib/approval-authority (review → approval).
 *
 * Every function runs under the current tenant context and enforces:
 * enterprise-only access, server-side validation, production isolation, secret
 * redaction, and the approved-and-fresh promotion gate.
 */
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { getTenantById } from "@/lib/tenant-service"
import { isValidSchemaName } from "@/lib/tenant-db/model"
import {
  getEffectiveTenantSettings,
  getTenantSettingsMap,
  getTenantSettingDefinition,
  setTenantSettings,
  validateTenantSetting,
} from "@/lib/tenant-settings"
import {
  actOnApprovalRequest,
  getRequestDetail,
  raiseApprovalRequest,
} from "@/lib/approval-authority"
import {
  assertSanitized,
  assertSandboxIsolation,
  baselineHash,
  diffConfig,
  evaluatePromotion,
  isEnterpriseTenant,
  isSandboxIsolated,
  isSecretKey,
  sanitizeConfigMap,
  type ConfigMap,
} from "./model"
import {
  createChangeRow,
  getChangeById,
  getSandboxEnvironment,
  isDuplicateSandboxAction,
  listChanges,
  listSandboxAudit,
  recordSandboxAudit,
  recordSandboxCopy,
  updateChangeRow,
  upsertSandboxEnvironment,
  type SandboxChangeRecord,
  type SandboxEnvironment,
} from "./store"

export const CHANGE_MODULE_KEY = "platform.config_change"

export class SandboxError extends Error {
  code: string
  status: number
  constructor(message: string, status = 400, code = "SANDBOX_ERROR") {
    super(message)
    this.name = "SandboxError"
    this.status = status
    this.code = code
  }
}

export type Actor = { userId: number; name?: string | null; email?: string | null }

// ---------------------------------------------------------------------------
// Enterprise gating + production connection reference
// ---------------------------------------------------------------------------

async function requireEnterpriseTenant(): Promise<{ id: number; type: string; schema: string | null; connectionRef: string | null }> {
  const tenantId = requireCurrentTenantId()
  const tenant = await getTenantById(tenantId)
  if (!tenant) throw new SandboxError("Tenant not found", 404, "TENANT_NOT_FOUND")
  if (!isEnterpriseTenant(tenant.tenant_type)) {
    throw new SandboxError("Sandbox is available to enterprise tenants only", 403, "NOT_ENTERPRISE")
  }
  return {
    id: tenant.id,
    type: tenant.tenant_type,
    schema: tenant.db_schema ?? null,
    connectionRef: tenant.db_connection_ref ?? null,
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type SandboxOverview = {
  enterprise: true
  environment: SandboxEnvironment | null
  isolated: boolean
  changes: SandboxChangeRecord[]
  audit: Awaited<ReturnType<typeof listSandboxAudit>>
}

export async function getSandboxOverview(): Promise<SandboxOverview> {
  const tenant = await requireEnterpriseTenant()
  const environment = await getSandboxEnvironment()
  // Sync any in-flight approvals so the console reflects the approval engine.
  const rawChanges = await listChanges()
  const changes: SandboxChangeRecord[] = []
  for (const change of rawChanges) {
    changes.push(await syncApprovalState(change))
  }
  const isolated = environment
    ? isSandboxIsolated(
        { schema: tenant.schema, connectionRef: tenant.connectionRef },
        { schema: environment.schema, connectionRef: environment.connectionRef },
      )
    : false
  return { enterprise: true, environment, isolated, changes, audit: await listSandboxAudit() }
}

// ---------------------------------------------------------------------------
// Configure the sandbox environment / connection set
// ---------------------------------------------------------------------------

export async function configureSandbox(
  input: { schema?: string | null; connectionRef?: string | null; region?: string | null },
  actor: Actor,
): Promise<SandboxEnvironment> {
  const tenant = await requireEnterpriseTenant()

  const schema = input.schema?.trim() || null
  const connectionRef = input.connectionRef?.trim() || null
  if (schema != null && !isValidSchemaName(schema)) {
    throw new SandboxError("Invalid sandbox schema name", 400, "INVALID_SCHEMA")
  }
  if (connectionRef != null && connectionRef.length > 190) {
    throw new SandboxError("Sandbox connection reference is too long", 400, "INVALID_CONNECTION_REF")
  }

  // Production isolation is enforced BEFORE persisting: a sandbox that shares the
  // production connection set is rejected, never stored.
  assertSandboxIsolation(
    { schema: tenant.schema, connectionRef: tenant.connectionRef },
    { schema, connectionRef },
  )

  const env = await upsertSandboxEnvironment({ status: "active", schema, connectionRef, region: input.region ?? null })
  await recordSandboxAudit({
    action: "configure",
    detail: { schema, connectionRef, region: input.region ?? null },
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
  })
  return env
}

// ---------------------------------------------------------------------------
// Sanitized production → sandbox copy
// ---------------------------------------------------------------------------

export async function copyProductionToSandbox(
  actor: Actor,
  idempotencyKey?: string | null,
): Promise<{ environment: SandboxEnvironment; deduplicated: boolean; keys: number }> {
  const tenant = await requireEnterpriseTenant()
  const env = await getSandboxEnvironment()
  if (!env || env.status !== "active") {
    throw new SandboxError("Configure the sandbox environment before copying", 409, "SANDBOX_NOT_READY")
  }
  // The sandbox must be isolated from production or a copy could round-trip onto
  // production data.
  if (
    !isSandboxIsolated(
      { schema: tenant.schema, connectionRef: tenant.connectionRef },
      { schema: env.schema, connectionRef: env.connectionRef },
    )
  ) {
    throw new SandboxError("Sandbox is not isolated from production", 409, "NOT_ISOLATED")
  }

  if (idempotencyKey && (await isDuplicateSandboxAction("copy", idempotencyKey))) {
    return { environment: env, deduplicated: true, keys: env.sanitizedConfig ? Object.keys(env.sanitizedConfig).length : 0 }
  }

  // Read the full effective production config (server-side, decrypted) and
  // sanitize it — every secret-bearing key is masked before it can land in the
  // sandbox. assertSanitized fails closed if any secret slips through.
  const production = await getEffectiveTenantSettings()
  const sanitized = sanitizeConfigMap(production as ConfigMap)
  assertSanitized(sanitized)

  await recordSandboxCopy(sanitized, actor.userId)
  await recordSandboxAudit({
    action: "copy",
    detail: { keys: Object.keys(sanitized).length, redacted: Object.keys(sanitized).filter(isSecretKey).length },
    idempotencyKey: idempotencyKey ?? null,
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
  })

  const refreshed = await getSandboxEnvironment()
  return { environment: refreshed!, deduplicated: false, keys: Object.keys(sanitized).length }
}

// ---------------------------------------------------------------------------
// Change requests: create → submit → approve/reject → promote → rollback
// ---------------------------------------------------------------------------

/** The production config the pipeline measures against (server-side, raw). */
async function productionConfig(): Promise<ConfigMap> {
  return (await getEffectiveTenantSettings()) as ConfigMap
}

/** Current override values (raw, decrypted) — the basis for a rollback snapshot. */
async function overrideValues(): Promise<ConfigMap> {
  return (await getTenantSettingsMap()) as ConfigMap
}

export async function createChange(
  input: { title: string; changes: Record<string, unknown> },
  actor: Actor,
): Promise<SandboxChangeRecord> {
  await requireEnterpriseTenant()

  const title = String(input.title ?? "").trim()
  if (!title) throw new SandboxError("A change title is required", 400, "TITLE_REQUIRED")
  if (title.length > 200) throw new SandboxError("Change title is too long", 400, "TITLE_TOO_LONG")
  if (!input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) {
    throw new SandboxError("A map of configuration changes is required", 400, "CHANGES_REQUIRED")
  }
  const keys = Object.keys(input.changes)
  if (keys.length === 0) throw new SandboxError("At least one configuration change is required", 400, "CHANGES_EMPTY")

  // Validate every key server-side. Secrets are managed by the dedicated secrets
  // subsystem and are deliberately NOT promotable through config changes, which
  // also keeps the stored diff / rollback snapshot free of any credential.
  const proposed: ConfigMap = {}
  for (const key of keys) {
    if (isSecretKey(key)) {
      throw new SandboxError(`Secret "${key}" cannot be changed through the sandbox pipeline`, 400, "SECRET_NOT_ALLOWED")
    }
    if (!getTenantSettingDefinition(key)) {
      throw new SandboxError(`Unknown configuration key: ${key}`, 400, "UNKNOWN_KEY")
    }
    const result = validateTenantSetting(key, input.changes[key])
    if (!result.ok) throw new SandboxError(result.error, 400, "INVALID_VALUE")
    proposed[key] = result.value
  }

  const production = await productionConfig()
  const scopedProduction: ConfigMap = {}
  for (const key of keys) scopedProduction[key] = production[key] ?? ""
  const diff = diffConfig(scopedProduction, proposed)
  if (diff.length === 0) {
    throw new SandboxError("The proposed configuration matches production; nothing to change", 400, "NO_CHANGE")
  }
  const hash = baselineHash(production, keys)

  const record = await createChangeRow({
    title,
    moduleKey: CHANGE_MODULE_KEY,
    proposed,
    diff,
    baselineHash: hash,
    createdBy: actor.userId,
    createdByName: actor.name ?? null,
  })
  await recordSandboxAudit({
    changeId: record.id,
    action: "create_change",
    detail: { title, keys },
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
  })
  return record
}

export async function submitChange(changeId: number, actor: Actor): Promise<SandboxChangeRecord> {
  await requireEnterpriseTenant()
  const change = await getChangeById(changeId)
  if (!change) throw new SandboxError("Change not found", 404, "CHANGE_NOT_FOUND")
  if (change.status !== "draft") {
    throw new SandboxError("Only draft changes can be submitted for approval", 409, "INVALID_STATE")
  }

  const raised = await raiseApprovalRequest({
    moduleKey: change.moduleKey,
    entityType: "sandbox_change",
    entityPk: change.id,
    title: change.title,
    requestedBy: actor.userId,
    requestedByName: actor.name ?? null,
  })

  const autoApproved = raised.status === "approved"
  const set: Record<string, any> = {
    approval_request_id: raised.requestId,
    approval_status: autoApproved ? "auto_approved" : "pending",
    status: autoApproved ? "approved" : "pending_approval",
  }
  if (autoApproved) {
    // No configured authority ⇒ approved immediately; freeze the production
    // baseline the approval is measured against for staleness.
    const production = await productionConfig()
    set.approved_baseline_hash = baselineHash(production, Object.keys(change.proposed))
    set.decided_at = new Date()
  }
  await updateChangeRow(change.id, set)
  await recordSandboxAudit({
    changeId: change.id,
    action: "submit_change",
    detail: { approvalRequestId: raised.requestId, autoApproved },
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
  })
  return (await getChangeById(change.id))!
}

/**
 * Reconcile a change's local status with its linked approval engine request.
 * Freezes the production baseline hash at the moment of approval so a later
 * production drift makes the approval stale.
 */
export async function syncApprovalState(change: SandboxChangeRecord): Promise<SandboxChangeRecord> {
  if (change.status !== "pending_approval" || change.approvalRequestId == null) return change
  const detail = await getRequestDetail(change.approvalRequestId)
  if (!detail) return change
  const status = detail.request.status
  if (status === "approved") {
    const production = await productionConfig()
    const lastApprove = [...detail.actions].reverse().find((a) => a.action === "approve")
    await updateChangeRow(change.id, {
      status: "approved",
      approval_status: "approved",
      approved_baseline_hash: baselineHash(production, Object.keys(change.proposed)),
      approver_user_id: lastApprove?.actorId ?? null,
      approver_name: lastApprove?.actorName ?? null,
      decided_at: detail.request.decidedAt ? new Date(detail.request.decidedAt) : new Date(),
    })
    return (await getChangeById(change.id))!
  }
  if (status === "rejected" || status === "cancelled") {
    await updateChangeRow(change.id, {
      status: status === "rejected" ? "rejected" : "cancelled",
      approval_status: status,
      decided_at: new Date(),
    })
    return (await getChangeById(change.id))!
  }
  return change
}

/** Convenience wrapper so approvers can act from the sandbox console too. */
export async function decideChange(
  changeId: number,
  action: "approve" | "reject",
  actor: Actor,
  opts: { isAdmin?: boolean; comment?: string | null } = {},
): Promise<SandboxChangeRecord> {
  await requireEnterpriseTenant()
  const change = await getChangeById(changeId)
  if (!change) throw new SandboxError("Change not found", 404, "CHANGE_NOT_FOUND")
  if (change.approvalRequestId == null || change.status !== "pending_approval") {
    throw new SandboxError("Change is not awaiting approval", 409, "NOT_PENDING")
  }
  const result = await actOnApprovalRequest(
    { requestId: change.approvalRequestId, actorId: actor.userId, actorName: actor.name ?? null, action, comment: opts.comment ?? null },
    { isAdmin: opts.isAdmin },
  )
  if (!result.ok) throw new SandboxError(result.error, result.code as number, "APPROVAL_ACTION_FAILED")
  await recordSandboxAudit({
    changeId: change.id,
    action: action === "approve" ? "approve_change" : "reject_change",
    detail: { requestId: change.approvalRequestId },
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
  })
  return syncApprovalState((await getChangeById(change.id))!)
}

export async function promoteChange(
  changeId: number,
  actor: Actor,
  idempotencyKey?: string | null,
): Promise<{ change: SandboxChangeRecord; deduplicated: boolean }> {
  const tenant = await requireEnterpriseTenant()
  let change = await getChangeById(changeId)
  if (!change) throw new SandboxError("Change not found", 404, "CHANGE_NOT_FOUND")
  change = await syncApprovalState(change)

  const env = await getSandboxEnvironment()
  const isolated =
    !!env &&
    isSandboxIsolated(
      { schema: tenant.schema, connectionRef: tenant.connectionRef },
      { schema: env.schema, connectionRef: env.connectionRef },
    )

  const keys = Object.keys(change.proposed)
  const production = await productionConfig()
  const currentHash = baselineHash(production, keys)

  // The single promotion gate: approved, isolated, fresh, not already promoted.
  const decision = evaluatePromotion({
    changeStatus: change.status,
    approvalStatus: (change.approvalStatus as any) ?? null,
    approvedBaselineHash: change.approvedBaselineHash,
    currentProductionHash: currentHash,
    isolated,
  })
  if (!decision.ok) {
    await recordSandboxAudit({
      changeId: change.id,
      action: "promote_denied",
      detail: { code: decision.code },
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
    })
    throw new SandboxError(decision.reason, 409, decision.code)
  }

  // Idempotent: a retried promotion under the same key is a no-op.
  if (idempotencyKey && (await isDuplicateSandboxAction("promote", idempotencyKey))) {
    return { change, deduplicated: true }
  }

  // Capture the pre-promotion production values (override layer) for rollback.
  const overrides = await overrideValues()
  const rollback: ConfigMap = {}
  for (const key of keys) rollback[key] = overrides[key] ?? ""

  await updateChangeRow(change.id, { deploy_status: "deploying" })
  try {
    await setTenantSettings(change.proposed, actor.userId)
  } catch (err) {
    await updateChangeRow(change.id, { deploy_status: "failed" })
    await recordSandboxAudit({
      changeId: change.id,
      action: "promote_failed",
      detail: { message: (err as Error).message },
      idempotencyKey: idempotencyKey ?? null,
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
    })
    throw new SandboxError("Promotion failed while applying configuration", 500, "PROMOTE_FAILED")
  }

  await updateChangeRow(change.id, {
    status: "promoted",
    deploy_status: "deployed",
    rollback_snapshot: JSON.stringify(rollback),
    promoted_at: new Date(),
    promoted_by: actor.userId,
  })
  await recordSandboxAudit({
    changeId: change.id,
    action: "promote",
    detail: { keys },
    idempotencyKey: idempotencyKey ?? null,
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
  })
  return { change: (await getChangeById(change.id))!, deduplicated: false }
}

export async function rollbackChange(
  changeId: number,
  actor: Actor,
  idempotencyKey?: string | null,
): Promise<{ change: SandboxChangeRecord; deduplicated: boolean }> {
  await requireEnterpriseTenant()
  const change = await getChangeById(changeId)
  if (!change) throw new SandboxError("Change not found", 404, "CHANGE_NOT_FOUND")
  if (change.status !== "promoted" || change.deployStatus !== "deployed") {
    throw new SandboxError("Only a deployed change can be rolled back", 409, "NOT_ROLLBACKABLE")
  }
  if (!change.rollbackSnapshot) {
    throw new SandboxError("No rollback snapshot is available for this change", 409, "NO_SNAPSHOT")
  }

  if (idempotencyKey && (await isDuplicateSandboxAction("rollback", idempotencyKey))) {
    return { change, deduplicated: true }
  }

  await setTenantSettings(change.rollbackSnapshot, actor.userId)
  await updateChangeRow(change.id, {
    status: "rolled_back",
    deploy_status: "rolled_back",
    rolled_back_at: new Date(),
  })
  await recordSandboxAudit({
    changeId: change.id,
    action: "rollback",
    detail: { keys: Object.keys(change.rollbackSnapshot) },
    idempotencyKey: idempotencyKey ?? null,
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
  })
  return { change: (await getChangeById(change.id))!, deduplicated: false }
}

export async function getChangeDetail(changeId: number): Promise<SandboxChangeRecord> {
  await requireEnterpriseTenant()
  const change = await getChangeById(changeId)
  if (!change) throw new SandboxError("Change not found", 404, "CHANGE_NOT_FOUND")
  return syncApprovalState(change)
}
