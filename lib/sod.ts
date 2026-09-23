// =============================================================================
// Segregation of Duties: DB persistence + orchestration.
// -----------------------------------------------------------------------------
// The server-side half of the SoD control. It:
//   - owns the per-tenant conflict configuration (enable/disable, enforcement
//     mode, severity, and admin-authored custom conflicts)
//   - resolves whether a user HOLDS each sensitive duty by reading their
//     effective permission matrix (create side) and the approval-authority
//     configuration (approve side)
//   - runs the pure policy engine (lib/sod-core.ts) to detect violations, both
//     for a live user and for a PROPOSED role/permission change (so assignment
//     endpoints can block before persisting)
//   - persists a violation snapshot for reporting and an append-only audit log
//
// All reads/writes are tenant-scoped via requireCurrentTenantId(). Admins are
// excluded from scanning: they are super-users with implicit full access, so
// flagging them would be noise rather than signal.
// =============================================================================

import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { getUserMatrix, getEffectiveUserMatrix } from "@/lib/permission-store"
import { getUserRoleIds, getRoleMatrix } from "@/lib/role-store"
import { listRules } from "@/lib/approval-authority"
import { mergeMatrices, type PermissionMatrix } from "@/lib/permission-model"
import {
  SOD_CONFLICTS,
  SOD_DUTIES,
  getBuiltinConflict,
  getDuty,
  type SodEnforcement,
  type SodSeverity,
} from "@/lib/sod-registry"
import {
  baseCategoryGranted,
  evaluateConflicts,
  hasBlockingViolation,
  peakSeverity,
  type ResolvedConflict,
  type SodViolation,
} from "@/lib/sod-core"

export type { ResolvedConflict, SodViolation }

let schemaReady: Promise<void> | null = null

/** Create the SoD tables once per process. Idempotent. */
export function ensureSodSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS sod_conflict_settings (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          tenant_id INT UNSIGNED NOT NULL,
          conflict_key VARCHAR(160) NOT NULL,
          label VARCHAR(200) DEFAULT NULL,
          description TEXT DEFAULT NULL,
          duty_a VARCHAR(120) DEFAULT NULL,
          duty_b VARCHAR(120) DEFAULT NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          enforcement ENUM('block','warn') NOT NULL DEFAULT 'block',
          severity ENUM('low','medium','high','critical') NOT NULL DEFAULT 'high',
          is_custom TINYINT(1) NOT NULL DEFAULT 0,
          created_by INT UNSIGNED DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uniq_sod_conflict (tenant_id, conflict_key)
        )
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS sod_violations (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          tenant_id INT UNSIGNED NOT NULL,
          user_id INT UNSIGNED NOT NULL,
          user_name VARCHAR(200) DEFAULT NULL,
          conflict_key VARCHAR(160) NOT NULL,
          conflict_label VARCHAR(200) DEFAULT NULL,
          duty_a VARCHAR(120) DEFAULT NULL,
          duty_b VARCHAR(120) DEFAULT NULL,
          severity ENUM('low','medium','high','critical') NOT NULL DEFAULT 'high',
          enforcement ENUM('block','warn') NOT NULL DEFAULT 'block',
          status ENUM('open','waived','resolved') NOT NULL DEFAULT 'open',
          note TEXT DEFAULT NULL,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          resolved_by INT UNSIGNED DEFAULT NULL,
          resolved_at TIMESTAMP NULL DEFAULT NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uniq_sod_violation (tenant_id, user_id, conflict_key),
          KEY idx_sod_violation_status (tenant_id, status)
        )
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS sod_audit (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          tenant_id INT UNSIGNED NOT NULL,
          action VARCHAR(60) NOT NULL,
          actor_id INT UNSIGNED DEFAULT NULL,
          actor_name VARCHAR(200) DEFAULT NULL,
          target_user_id INT UNSIGNED DEFAULT NULL,
          target_user_name VARCHAR(200) DEFAULT NULL,
          conflict_key VARCHAR(160) DEFAULT NULL,
          summary VARCHAR(400) DEFAULT NULL,
          detail JSON DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_sod_audit_tenant (tenant_id, created_at)
        )
      `)
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

// ---------------------------------------------------------------------------
// Conflict configuration
// ---------------------------------------------------------------------------

type SettingRow = {
  conflict_key: string
  label: string | null
  description: string | null
  duty_a: string | null
  duty_b: string | null
  enabled: number
  enforcement: SodEnforcement
  severity: SodSeverity
  is_custom: number
}

/**
 * The effective conflict matrix for the current tenant: every built-in
 * conflict (with any per-tenant override applied) plus any admin-authored
 * custom conflicts. This is what the policy engine evaluates against.
 */
export async function getResolvedConflicts(): Promise<ResolvedConflict[]> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<SettingRow[]>(
    `SELECT conflict_key, label, description, duty_a, duty_b, enabled, enforcement, severity, is_custom
       FROM sod_conflict_settings WHERE tenant_id = ?`,
    [tenantId],
  )
  const overrides = new Map(rows.map((r) => [r.conflict_key, r]))

  const resolved: ResolvedConflict[] = SOD_CONFLICTS.map((def) => {
    const o = overrides.get(def.key)
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      dutyA: def.dutyA,
      dutyB: def.dutyB,
      severity: o ? o.severity : def.severity,
      enforcement: o ? o.enforcement : def.defaultEnforcement,
      enabled: o ? Boolean(o.enabled) : def.defaultEnabled,
      custom: false,
    }
  })

  for (const r of rows) {
    if (!r.is_custom) continue
    if (!r.duty_a || !r.duty_b) continue
    resolved.push({
      key: r.conflict_key,
      label: r.label || r.conflict_key,
      description: r.description || "",
      dutyA: r.duty_a,
      dutyB: r.duty_b,
      severity: r.severity,
      enforcement: r.enforcement,
      enabled: Boolean(r.enabled),
      custom: true,
    })
  }
  return resolved
}

/** Update enable/enforcement/severity for a built-in or custom conflict. */
export async function updateConflictSetting(
  conflictKey: string,
  patch: { enabled?: boolean; enforcement?: SodEnforcement; severity?: SodSeverity },
): Promise<void> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  const builtin = getBuiltinConflict(conflictKey)

  // Seed base values from the built-in default (or existing row for custom).
  const existing = await query<SettingRow[]>(
    `SELECT * FROM sod_conflict_settings WHERE tenant_id = ? AND conflict_key = ? LIMIT 1`,
    [tenantId, conflictKey],
  )
  const base = existing[0]
  if (!base && !builtin) {
    throw new Error("Unknown conflict")
  }

  const enabled = patch.enabled ?? (base ? Boolean(base.enabled) : builtin!.defaultEnabled)
  const enforcement = patch.enforcement ?? (base ? base.enforcement : builtin!.defaultEnforcement)
  const severity = patch.severity ?? (base ? base.severity : builtin!.severity)

  await query(
    `INSERT INTO sod_conflict_settings
       (tenant_id, conflict_key, label, description, duty_a, duty_b, enabled, enforcement, severity, is_custom)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), enforcement = VALUES(enforcement), severity = VALUES(severity)`,
    [
      tenantId,
      conflictKey,
      base?.label ?? builtin?.label ?? null,
      base?.description ?? builtin?.description ?? null,
      base?.duty_a ?? builtin?.dutyA ?? null,
      base?.duty_b ?? builtin?.dutyB ?? null,
      enabled ? 1 : 0,
      enforcement,
      severity,
      base ? base.is_custom : 0,
    ],
  )
}

/** Create an admin-authored custom conflict between two catalog duties. */
export async function createCustomConflict(input: {
  label: string
  description?: string
  dutyA: string
  dutyB: string
  severity: SodSeverity
  enforcement: SodEnforcement
  createdBy: number
}): Promise<string> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  if (!getDuty(input.dutyA) || !getDuty(input.dutyB)) throw new Error("Unknown duty")
  if (input.dutyA === input.dutyB) throw new Error("A conflict needs two different duties")
  const key = `custom.${input.dutyA}__${input.dutyB}.${Date.now().toString(36)}`
  await query(
    `INSERT INTO sod_conflict_settings
       (tenant_id, conflict_key, label, description, duty_a, duty_b, enabled, enforcement, severity, is_custom, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
    [
      tenantId,
      key,
      input.label,
      input.description ?? null,
      input.dutyA,
      input.dutyB,
      1,
      input.enforcement,
      input.severity,
      input.createdBy,
    ],
  )
  return key
}

/** Delete a custom conflict (built-in conflicts can only be disabled). */
export async function deleteCustomConflict(conflictKey: string): Promise<void> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  await query(`DELETE FROM sod_conflict_settings WHERE tenant_id = ? AND conflict_key = ? AND is_custom = 1`, [
    tenantId,
    conflictKey,
  ])
}

// ---------------------------------------------------------------------------
// Duty resolution
// ---------------------------------------------------------------------------

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase()
}

/** The department name attached to a user's employee record, if any. */
async function getUserDepartment(userId: number): Promise<string | null> {
  try {
    const rows = await query<{ department: string | null }[]>(
      `SELECT department FROM hr_employees WHERE user_id = ? LIMIT 1`,
      [userId],
    )
    return rows[0]?.department ?? null
  } catch {
    return null
  }
}

/**
 * The approval-authority module keys a user can act on — i.e. the modules for
 * which they are a configured approver, whether named directly, via one of
 * their roles, or via their department. Dynamic approver slots
 * (requester_manager / department_head / entity_owner) are contextual and
 * cannot be statically attributed to a user, so they are intentionally ignored.
 */
async function getUserApprovalModuleKeys(
  userId: number,
  roleIds: ReadonlySet<number>,
): Promise<Set<string>> {
  const out = new Set<string>()
  let rules: Awaited<ReturnType<typeof listRules>>
  try {
    rules = await listRules()
  } catch {
    return out
  }
  const dept = norm(await getUserDepartment(userId))

  const matches = (kind: string, value: string): boolean => {
    if (kind === "user") return Number(value) === userId
    if (kind === "role") return roleIds.has(Number(value))
    if (kind === "department") return dept !== "" && norm(value) === dept
    return false
  }

  for (const rule of rules) {
    if (!rule.active) continue
    let hit = false
    for (const level of rule.levels) {
      for (const ap of level.approvers) {
        if (matches(ap.kind, ap.value)) {
          hit = true
          break
        }
      }
      if (!hit && level.escalateTo && matches(level.escalateTo.kind, level.escalateTo.value)) {
        hit = true
      }
      if (hit) break
    }
    if (hit) out.add(norm(rule.moduleKey))
  }
  return out
}

/**
 * Resolve which catalog duties a user holds. `matrix` is the effective
 * permission matrix to evaluate (may be a proposed one); `roleIds` is the role
 * set used for approval membership. A null matrix means the user has no
 * configured matrix and therefore has legacy full access — they hold every
 * create-side (permission) duty. That is the security-correct reading for SoD:
 * an unrestricted account is exactly what these controls exist to surface.
 */
async function resolveHeldDuties(
  userId: number,
  matrix: PermissionMatrix | null,
  roleIds: ReadonlySet<number>,
): Promise<Set<string>> {
  const held = new Set<string>()
  const approvalKeys = await getUserApprovalModuleKeys(userId, roleIds)

  for (const duty of SOD_DUTIES) {
    if (duty.signal.type === "permission") {
      if (matrix === null) {
        held.add(duty.key)
      } else {
        const perm = matrix[duty.signal.moduleKey]
        if (baseCategoryGranted(perm, duty.signal.category)) held.add(duty.key)
      }
    } else {
      const wanted = duty.signal.moduleKeys.map(norm)
      if (wanted.some((k) => approvalKeys.has(k))) held.add(duty.key)
    }
  }
  return held
}

export type UserDutyReport = {
  held: string[]
  violations: SodViolation[]
}

/** Evaluate a user's CURRENT duties and violations against the live matrix. */
export async function evaluateUser(userId: number): Promise<UserDutyReport> {
  const tenantId = requireCurrentTenantId()
  const [matrix, roleIds, conflicts] = await Promise.all([
    getEffectiveUserMatrix(userId),
    getUserRoleIds(tenantId, userId),
    getResolvedConflicts(),
  ])
  const held = await resolveHeldDuties(userId, matrix, new Set(roleIds))
  return { held: [...held], violations: evaluateConflicts(held, conflicts) }
}

/** Merge several role matrices into one effective role-derived matrix. */
async function matrixForRoleIds(tenantId: number, roleIds: number[]): Promise<PermissionMatrix | null> {
  if (roleIds.length === 0) return null
  const matrices = await Promise.all(roleIds.map((id) => getRoleMatrix(tenantId, id).catch(() => null)))
  return mergeMatrices(matrices)
}

/**
 * Evaluate the duties a user WOULD hold if their role assignment changed to
 * `roleIds`, without persisting anything. Used by the role-assignment endpoints
 * to block a change that would create a conflict.
 */
export async function evaluateProposedRoles(userId: number, roleIds: number[]): Promise<UserDutyReport> {
  const tenantId = requireCurrentTenantId()
  const [personal, rolesMatrix, conflicts] = await Promise.all([
    getUserMatrix(userId),
    matrixForRoleIds(tenantId, roleIds),
    getResolvedConflicts(),
  ])
  const effective = rolesMatrix || personal ? mergeMatrices([rolesMatrix, personal]) : null
  const held = await resolveHeldDuties(userId, effective, new Set(roleIds))
  return { held: [...held], violations: evaluateConflicts(held, conflicts) }
}

/**
 * Evaluate the duties a user WOULD hold if their PERSONAL matrix changed to
 * `matrix` (roles unchanged), without persisting anything.
 */
export async function evaluateProposedMatrix(
  userId: number,
  matrix: PermissionMatrix,
): Promise<UserDutyReport> {
  const tenantId = requireCurrentTenantId()
  const [roleIds, conflicts] = await Promise.all([getUserRoleIds(tenantId, userId), getResolvedConflicts()])
  const rolesMatrix = await matrixForRoleIds(tenantId, roleIds)
  const effective = mergeMatrices([rolesMatrix, matrix])
  const held = await resolveHeldDuties(userId, effective, new Set(roleIds))
  return { held: [...held], violations: evaluateConflicts(held, conflicts) }
}

export { hasBlockingViolation, peakSeverity }

// ---------------------------------------------------------------------------
// Tenant-wide scan + violation snapshot
// ---------------------------------------------------------------------------

export type ViolationRow = {
  id: number
  userId: number
  userName: string | null
  conflictKey: string
  conflictLabel: string | null
  dutyA: string | null
  dutyB: string | null
  severity: SodSeverity
  enforcement: SodEnforcement
  status: "open" | "waived" | "resolved"
  note: string | null
  detectedAt: string
  resolvedAt: string | null
}

type UserRow = { id: number; name: string | null }

/**
 * Re-evaluate every non-admin user in the tenant and reconcile the violation
 * snapshot: newly-detected violations are inserted (or reactivated), and any
 * previously-open violation that no longer holds is marked resolved. Waived
 * violations are left untouched so an accepted risk stays accepted until it
 * genuinely clears. Returns the current open/waived violations.
 */
export async function scanTenant(): Promise<ViolationRow[]> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  const conflicts = await getResolvedConflicts()

  const users = await query<UserRow[]>(
    `SELECT id, name FROM users WHERE tenant_id = ? AND role = 'employee'`,
    [tenantId],
  )

  // conflictKey|userId -> violation currently detected
  const detected = new Map<string, SodViolation & { userId: number; userName: string | null }>()
  for (const u of users) {
    const [matrix, roleIds] = await Promise.all([getEffectiveUserMatrix(u.id), getUserRoleIds(tenantId, u.id)])
    const held = await resolveHeldDuties(u.id, matrix, new Set(roleIds))
    for (const v of evaluateConflicts(held, conflicts)) {
      detected.set(`${u.id}|${v.conflictKey}`, { ...v, userId: u.id, userName: u.name })
    }
  }

  // Upsert every detected violation as open (without clobbering a waiver).
  for (const v of detected.values()) {
    await query(
      `INSERT INTO sod_violations
         (tenant_id, user_id, user_name, conflict_key, conflict_label, duty_a, duty_b, severity, enforcement, status)
       VALUES (?,?,?,?,?,?,?,?,?, 'open')
       ON DUPLICATE KEY UPDATE
         user_name = VALUES(user_name),
         conflict_label = VALUES(conflict_label),
         duty_a = VALUES(duty_a),
         duty_b = VALUES(duty_b),
         severity = VALUES(severity),
         enforcement = VALUES(enforcement),
         status = CASE WHEN status = 'waived' THEN 'waived' ELSE 'open' END,
         resolved_at = CASE WHEN status = 'waived' THEN resolved_at ELSE NULL END`,
      [
        tenantId,
        v.userId,
        v.userName,
        v.conflictKey,
        v.conflictLabel,
        v.dutyA,
        v.dutyB,
        v.severity,
        v.enforcement,
      ],
    )
  }

  // Resolve any previously-open violation that is no longer detected.
  const openRows = await query<{ id: number; user_id: number; conflict_key: string }[]>(
    `SELECT id, user_id, conflict_key FROM sod_violations WHERE tenant_id = ? AND status = 'open'`,
    [tenantId],
  )
  const staleIds = openRows
    .filter((r) => !detected.has(`${r.user_id}|${r.conflict_key}`))
    .map((r) => r.id)
  if (staleIds.length > 0) {
    await query(
      `UPDATE sod_violations SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
        WHERE id IN (${staleIds.map(() => "?").join(",")})`,
      staleIds,
    )
  }

  return listViolations()
}

/** The current violation snapshot (open + waived), newest first. */
export async function listViolations(): Promise<ViolationRow[]> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT * FROM sod_violations
      WHERE tenant_id = ? AND status <> 'resolved'
      ORDER BY FIELD(severity,'critical','high','medium','low'), detected_at DESC`,
    [tenantId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    userId: Number(r.user_id),
    userName: r.user_name ?? null,
    conflictKey: r.conflict_key,
    conflictLabel: r.conflict_label ?? null,
    dutyA: r.duty_a ?? null,
    dutyB: r.duty_b ?? null,
    severity: r.severity,
    enforcement: r.enforcement,
    status: r.status,
    note: r.note ?? null,
    detectedAt: r.detected_at,
    resolvedAt: r.resolved_at ?? null,
  }))
}

/** Waive (accept the risk of) or re-open a violation. */
export async function setViolationStatus(
  violationId: number,
  status: "open" | "waived",
  actor: { id: number; name?: string | null },
  note?: string,
): Promise<void> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  await query(
    `UPDATE sod_violations
        SET status = ?, note = ?, resolved_by = ?, resolved_at = ${status === "waived" ? "CURRENT_TIMESTAMP" : "NULL"}
      WHERE id = ? AND tenant_id = ?`,
    [status, note ?? null, actor.id, violationId, tenantId],
  )
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type SodAuditAction =
  | "config_updated"
  | "custom_conflict_created"
  | "custom_conflict_deleted"
  | "assignment_blocked"
  | "assignment_overridden"
  | "scan_run"
  | "violation_waived"
  | "violation_reopened"

/** Append an entry to the SoD audit trail. Best-effort — never throws. */
export async function logSodAudit(entry: {
  action: SodAuditAction
  actorId?: number | null
  actorName?: string | null
  targetUserId?: number | null
  targetUserName?: string | null
  conflictKey?: string | null
  summary?: string | null
  detail?: Record<string, unknown> | null
}): Promise<void> {
  try {
    await ensureSodSchema()
    const tenantId = requireCurrentTenantId()
    await query(
      `INSERT INTO sod_audit
         (tenant_id, action, actor_id, actor_name, target_user_id, target_user_name, conflict_key, summary, detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        tenantId,
        entry.action,
        entry.actorId ?? null,
        entry.actorName ?? null,
        entry.targetUserId ?? null,
        entry.targetUserName ?? null,
        entry.conflictKey ?? null,
        entry.summary ?? null,
        entry.detail && Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : null,
      ],
    )
  } catch (err) {
    console.error("[v0] logSodAudit failed:", (err as Error).message)
  }
}

export type SodAuditRow = {
  id: number
  action: string
  actorId: number | null
  actorName: string | null
  targetUserId: number | null
  targetUserName: string | null
  conflictKey: string | null
  summary: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

/** The audit trail for the tenant, newest first. */
export async function listSodAudit(limit = 200): Promise<SodAuditRow[]> {
  await ensureSodSchema()
  const tenantId = requireCurrentTenantId()
  const rows = await query<any[]>(
    `SELECT * FROM sod_audit WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [tenantId, limit],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    actorId: r.actor_id != null ? Number(r.actor_id) : null,
    actorName: r.actor_name ?? null,
    targetUserId: r.target_user_id != null ? Number(r.target_user_id) : null,
    targetUserName: r.target_user_name ?? null,
    conflictKey: r.conflict_key ?? null,
    summary: r.summary ?? null,
    detail: typeof r.detail === "string" ? safeParse(r.detail) : (r.detail ?? null),
    createdAt: r.created_at,
  }))
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
