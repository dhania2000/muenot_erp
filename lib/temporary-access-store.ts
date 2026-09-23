import "server-only"
/**
 * SPEC 64 — Temporary access & SPEC 65 — Break-glass (emergency) access.
 * ---------------------------------------------------------------------------
 * A single, server-enforced, audited engine for time-boxed access grants:
 *
 *   kind = "temporary"  → an admin grants a user a time-boxed access window
 *                         and/or a temporary role elevation. May be scheduled
 *                         to start in the future.
 *   kind = "break_glass"→ a user requests emergency elevated access for an
 *                         active incident. Requires a mandatory reason and an
 *                         explicit approval by a DIFFERENT admin before it goes
 *                         active. Fully audited and notified. "No silent usage."
 *
 * Enforcement is real, not cosmetic:
 *   - Role elevation is applied to `users.tenant_role` / `users.role`, which
 *     the request guards (lib/platform-guard.ts) re-resolve from the DB on
 *     every request — so the elevation takes effect immediately and reverts
 *     the instant the grant ends.
 *   - Access windows are written to `users.access_expires_at`, which the login
 *     gate (lib/user-lifecycle-core.ts `evaluateLogin`) already treats as a
 *     hard block once passed.
 *
 * Automatic revocation is driven by the allow-listed cron job
 * `/api/cron/temporary-access` (see lib/cron-jobs.ts), which calls
 * `runDueTransitionsForTenant()` inside the per-tenant scope. The scheduling
 * decisions themselves are the pure, unit-tested core in
 * lib/temporary-access-core.ts.
 *
 * Self-heals its schema at runtime (same pattern as lib/session-store.ts /
 * lib/access-policy-store.ts) so existing databases converge with no manual
 * migration step; a matching migration is also shipped for fresh installs.
 */
import { query, withTransaction } from "@/lib/db"
import { tenantRoleToLegacy, type TenantRole } from "@/lib/role-model"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import { recordActivity } from "@/lib/notifications"
import {
  clampDurationMinutes,
  computeDueTransitions,
  type CoreGrant,
  type GrantableTenantRole,
  type GrantKind,
  type GrantStatus,
  isGrantableTenantRole,
  validateWindow,
} from "@/lib/temporary-access-core"

export class TemporaryAccessError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "TemporaryAccessError"
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessGrant = {
  id: number
  tenantId: number
  kind: GrantKind
  status: GrantStatus
  userId: number
  userName: string | null
  userEmail: string | null
  grantedRole: GrantableTenantRole | null
  previousRole: string | null
  scope: string
  reason: string
  approverUserId: number | null
  approverName: string | null
  requestedBy: number
  requestedByName: string | null
  notifySecurity: boolean
  startAt: string
  expiresAt: string
  activatedAt: string | null
  endedAt: string | null
  endReason: string | null
  createdAt: string
}

type GrantRow = {
  id: number
  tenant_id: number
  kind: GrantKind
  status: GrantStatus
  user_id: number
  user_name: string | null
  user_email: string | null
  granted_role: string | null
  previous_role: string | null
  scope: string
  reason: string
  approver_user_id: number | null
  approver_name: string | null
  requested_by: number
  requested_by_name: string | null
  notify_security: number
  start_at: string
  expires_at: string
  activated_at: string | null
  ended_at: string | null
  end_reason: string | null
  created_at: string
}

export type Actor = { userId: number; name?: string | null; email?: string | null }

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`temporary_access_grants\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`kind\` ENUM('temporary','break_glass') NOT NULL DEFAULT 'temporary',
      \`status\` ENUM('pending','active','expired','revoked','rejected') NOT NULL DEFAULT 'pending',
      \`user_id\` INT UNSIGNED NOT NULL,
      \`user_name\` VARCHAR(190) DEFAULT NULL,
      \`user_email\` VARCHAR(190) DEFAULT NULL,
      \`granted_role\` VARCHAR(24) DEFAULT NULL,
      \`previous_role\` VARCHAR(24) DEFAULT NULL,
      \`scope\` VARCHAR(300) NOT NULL,
      \`reason\` VARCHAR(1000) NOT NULL,
      \`approver_user_id\` INT UNSIGNED DEFAULT NULL,
      \`approver_name\` VARCHAR(190) DEFAULT NULL,
      \`requested_by\` INT UNSIGNED NOT NULL,
      \`requested_by_name\` VARCHAR(190) DEFAULT NULL,
      \`notify_security\` TINYINT(1) NOT NULL DEFAULT 0,
      \`start_at\` DATETIME NOT NULL,
      \`expires_at\` DATETIME NOT NULL,
      \`activated_at\` DATETIME DEFAULT NULL,
      \`ended_at\` DATETIME DEFAULT NULL,
      \`end_reason\` VARCHAR(300) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_tag_tenant\` (\`tenant_id\`),
      KEY \`idx_tag_user\` (\`user_id\`),
      KEY \`idx_tag_kind\` (\`kind\`),
      KEY \`idx_tag_status\` (\`status\`),
      KEY \`idx_tag_due\` (\`status\`, \`expires_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureTemporaryAccessSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

function toPublic(row: GrantRow): AccessGrant {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    kind: row.kind,
    status: row.status,
    userId: Number(row.user_id),
    userName: row.user_name,
    userEmail: row.user_email,
    grantedRole: isGrantableTenantRole(row.granted_role) ? row.granted_role : null,
    previousRole: row.previous_role,
    scope: row.scope,
    reason: row.reason,
    approverUserId: row.approver_user_id != null ? Number(row.approver_user_id) : null,
    approverName: row.approver_name,
    requestedBy: Number(row.requested_by),
    requestedByName: row.requested_by_name,
    notifySecurity: Boolean(row.notify_security),
    startAt: row.start_at,
    expiresAt: row.expires_at,
    activatedAt: row.activated_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    createdAt: row.created_at,
  }
}

const SELECT = `SELECT * FROM \`temporary_access_grants\``

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type SubjectUser = { id: number; name: string; email: string; tenantRole: TenantRole; lifecycleState: string }

async function loadTenantUser(tenantId: number, userId: number): Promise<SubjectUser | null> {
  const rows = await query<any[]>(
    `SELECT id, name, email, tenant_role, role, lifecycle_state FROM \`users\` WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [userId, tenantId],
  )
  const r = rows[0]
  if (!r) return null
  const tenantRole = (r.tenant_role || (r.role === "admin" ? "tenant_admin" : "employee")) as TenantRole
  return {
    id: Number(r.id),
    name: r.name ?? "",
    email: r.email ?? "",
    tenantRole,
    lifecycleState: r.lifecycle_state ?? "active",
  }
}

/** Apply a role elevation, recording the role we replaced so it can be restored. */
async function applyElevation(tenantId: number, userId: number, grantedRole: GrantableTenantRole, previousRole: string) {
  const legacy = tenantRoleToLegacy(grantedRole)
  await query(`UPDATE \`users\` SET \`tenant_role\` = ?, \`role\` = ? WHERE id = ? AND tenant_id = ? AND \`tenant_role\` = ?`, [
    grantedRole,
    legacy,
    userId,
    tenantId,
    previousRole,
  ])
}

/**
 * Revert a role elevation — but ONLY if the user still holds exactly the role
 * this grant elevated them to. If an admin has since changed their role, we
 * must not clobber that newer decision.
 */
async function restoreElevation(tenantId: number, userId: number, grantedRole: string, previousRole: string) {
  const legacy = tenantRoleToLegacy(previousRole as TenantRole)
  await query(`UPDATE \`users\` SET \`tenant_role\` = ?, \`role\` = ? WHERE id = ? AND tenant_id = ? AND \`tenant_role\` = ?`, [
    previousRole,
    legacy,
    userId,
    tenantId,
    grantedRole,
  ])
}

/** Set the login-enforced access window for a subject. */
async function setAccessWindow(tenantId: number, userId: number, expiresAt: string | null) {
  await query(`UPDATE \`users\` SET \`access_expires_at\` = ? WHERE id = ? AND tenant_id = ?`, [expiresAt, userId, tenantId])
}

/** Clear the access window ONLY if it still matches this grant's expiry. */
async function clearAccessWindow(tenantId: number, userId: number, expiresAt: string) {
  await query(
    `UPDATE \`users\` SET \`access_expires_at\` = NULL
       WHERE id = ? AND tenant_id = ? AND \`access_expires_at\` = ?`,
    [userId, tenantId, expiresAt],
  )
}

function auditCategory(kind: GrantKind) {
  return kind === "break_glass" ? ("break_glass" as const) : ("temporary_access" as const)
}

async function notify(grant: AccessGrant, title: string, actor: Actor) {
  try {
    await recordActivity({
      action: "update",
      title,
      body: `${grant.kind === "break_glass" ? "Break-glass" : "Temporary"} access · ${grant.scope}`,
      link: grant.kind === "break_glass" ? "/admin/security/emergency-access" : "/admin/security/temporary-access",
      actor: actor.userId
        ? { userId: actor.userId, name: actor.name ?? "", email: actor.email ?? "", role: "admin" }
        : undefined,
    })
  } catch (err) {
    console.error("[temporary-access] notify failed (ignored):", err)
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listGrants(
  tenantId: number,
  opts: { kind?: GrantKind; limit?: number } = {},
): Promise<AccessGrant[]> {
  await ensureTemporaryAccessSchema()
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)
  const params: unknown[] = [tenantId]
  let sql = `${SELECT} WHERE tenant_id = ?`
  if (opts.kind) {
    sql += ` AND kind = ?`
    params.push(opts.kind)
  }
  sql += ` ORDER BY FIELD(status,'active','pending','expired','revoked','rejected'), id DESC LIMIT ?`
  params.push(limit)
  const rows = await query<GrantRow[]>(sql, params)
  return rows.map(toPublic)
}

/** Active break-glass grants for a given user — drives the persistent banner. */
export async function listActiveBreakGlassForUser(tenantId: number, userId: number): Promise<AccessGrant[]> {
  await ensureTemporaryAccessSchema()
  const rows = await query<GrantRow[]>(
    `${SELECT} WHERE tenant_id = ? AND user_id = ? AND kind = 'break_glass' AND status = 'active' AND expires_at > NOW()
       ORDER BY expires_at ASC`,
    [tenantId, userId],
  )
  return rows.map(toPublic)
}

async function requireGrant(tenantId: number, id: number): Promise<AccessGrant> {
  await ensureTemporaryAccessSchema()
  const rows = await query<GrantRow[]>(`${SELECT} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId])
  if (!rows[0]) throw new TemporaryAccessError("Access grant not found", 404)
  return toPublic(rows[0])
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateTemporaryInput = {
  userId: number
  grantedRole?: string | null
  scope: string
  reason: string
  approverName?: string | null
  startAt: Date
  expiresAt: Date
}

/**
 * SPEC 64 — grant a temporary access window and/or role elevation to a user.
 * If the start time has already passed the grant activates immediately;
 * otherwise it is scheduled and the cron scheduler activates it when due.
 */
export async function createTemporaryGrant(
  tenantId: number,
  actor: Actor,
  input: CreateTemporaryInput,
): Promise<AccessGrant> {
  await ensureTemporaryAccessSchema()
  const subject = await loadTenantUser(tenantId, input.userId)
  if (!subject) throw new TemporaryAccessError("User not found in this organization", 404)
  if (subject.lifecycleState !== "active") {
    throw new TemporaryAccessError("Temporary access can only be granted to an active user", 409)
  }

  const scope = String(input.scope ?? "").trim()
  if (!scope) throw new TemporaryAccessError("A scope is required")
  const reason = String(input.reason ?? "").trim()
  if (!reason) throw new TemporaryAccessError("A reason is required")

  let grantedRole: GrantableTenantRole | null = null
  if (input.grantedRole) {
    if (!isGrantableTenantRole(input.grantedRole)) {
      throw new TemporaryAccessError("That role cannot be granted temporarily")
    }
    grantedRole = input.grantedRole
  }

  const now = Date.now()
  const startAt = input.startAt.getTime()
  const expiresAt = input.expiresAt.getTime()
  const windowCheck = validateWindow(Math.max(startAt, now - 60_000), expiresAt, now)
  if (!windowCheck.ok) throw new TemporaryAccessError(windowCheck.error)

  const activateNow = startAt <= now
  const startSql = sqlDate(new Date(Math.max(startAt, now)))
  const expiresSql = sqlDate(input.expiresAt)

  const previousRole = subject.tenantRole
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`temporary_access_grants\`
       (tenant_id, kind, status, user_id, user_name, user_email, granted_role, previous_role,
        scope, reason, approver_user_id, approver_name, requested_by, requested_by_name, notify_security,
        start_at, expires_at, activated_at)
     VALUES (?, 'temporary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      tenantId,
      activateNow ? "active" : "pending",
      subject.id,
      subject.name,
      subject.email,
      grantedRole,
      grantedRole ? previousRole : null,
      scope.slice(0, 300),
      reason.slice(0, 1000),
      actor.userId,
      String(input.approverName ?? actor.name ?? "").slice(0, 190) || null,
      actor.userId,
      actor.name ?? null,
      startSql,
      expiresSql,
      activateNow ? sqlDate(new Date(now)) : null,
    ],
  )
  const id = Number((result as any).insertId)

  if (activateNow) {
    if (grantedRole) await applyElevation(tenantId, subject.id, grantedRole, previousRole)
    await setAccessWindow(tenantId, subject.id, expiresSql)
  }

  const grant = await requireGrant(tenantId, id)
  await recordSecurityEvent({
    tenantId,
    category: "temporary_access",
    action: activateNow ? "grant_activated" : "grant_scheduled",
    outcome: activateNow ? "activated" : "granted",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    subjectEmail: subject.email,
    detail: { grantId: id, grantedRole, scope, expiresAt: expiresSql },
  })
  await notify(grant, `Temporary access ${activateNow ? "granted to" : "scheduled for"} ${subject.name}`, actor)
  return grant
}

export type CreateBreakGlassInput = {
  grantedRole?: string | null
  scope: string
  reason: string
  approverName?: string | null
  durationMinutes: number
  notifySecurity?: boolean
}

/**
 * SPEC 65 — a user requests emergency (break-glass) elevated access for
 * themselves. Always created in `pending`: a DIFFERENT admin must explicitly
 * approve it before any elevation is applied. A mandatory reason is enforced.
 */
export async function createBreakGlassRequest(
  tenantId: number,
  actor: Actor,
  input: CreateBreakGlassInput,
): Promise<AccessGrant> {
  await ensureTemporaryAccessSchema()
  const subject = await loadTenantUser(tenantId, actor.userId)
  if (!subject) throw new TemporaryAccessError("Requesting user not found in this organization", 404)

  const scope = String(input.scope ?? "").trim()
  if (!scope) throw new TemporaryAccessError("A scope is required")
  const reason = String(input.reason ?? "").trim()
  if (!reason) throw new TemporaryAccessError("A justification is required for emergency access")

  let grantedRole: GrantableTenantRole = "tenant_admin"
  if (input.grantedRole) {
    if (!isGrantableTenantRole(input.grantedRole)) {
      throw new TemporaryAccessError("That role cannot be granted via break-glass access")
    }
    grantedRole = input.grantedRole
  }

  const durationMinutes = clampDurationMinutes(Number(input.durationMinutes))
  const now = Date.now()
  const expiresAt = new Date(now + durationMinutes * 60_000)

  const result = await query<{ insertId: number }>(
    `INSERT INTO \`temporary_access_grants\`
       (tenant_id, kind, status, user_id, user_name, user_email, granted_role, previous_role,
        scope, reason, approver_user_id, approver_name, requested_by, requested_by_name, notify_security,
        start_at, expires_at)
     VALUES (?, 'break_glass', 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      subject.id,
      subject.name,
      subject.email,
      grantedRole,
      subject.tenantRole,
      scope.slice(0, 300),
      reason.slice(0, 1000),
      String(input.approverName ?? "").slice(0, 190) || null,
      actor.userId,
      actor.name ?? null,
      input.notifySecurity === false ? 0 : 1,
      sqlDate(new Date(now)),
      sqlDate(expiresAt),
    ],
  )
  const id = Number((result as any).insertId)
  const grant = await requireGrant(tenantId, id)

  await recordSecurityEvent({
    tenantId,
    category: "break_glass",
    action: "request_created",
    outcome: "created",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    subjectEmail: subject.email,
    detail: { grantId: id, grantedRole, scope, durationMinutes },
  })
  await notify(grant, `Break-glass access requested by ${subject.name}`, actor)
  return grant
}

// ---------------------------------------------------------------------------
// Approve / reject / revoke
// ---------------------------------------------------------------------------

/** SPEC 65 — approve a pending break-glass request and activate the elevation. */
export async function approveGrant(tenantId: number, id: number, actor: Actor): Promise<AccessGrant> {
  const grant = await requireGrant(tenantId, id)
  if (grant.status !== "pending") throw new TemporaryAccessError("Only a pending request can be approved", 409)
  if (grant.requestedBy === actor.userId) {
    // Explicit authorization requires a second person — the requester can never
    // self-approve their own break-glass elevation.
    throw new TemporaryAccessError("A break-glass request must be approved by a different administrator", 403)
  }

  const now = new Date()
  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE \`temporary_access_grants\`
         SET status = 'active', approver_user_id = ?, approver_name = ?, activated_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
      [actor.userId, actor.name ?? null, sqlDate(now), id, tenantId],
    )
  })

  if (grant.grantedRole && grant.previousRole) {
    await applyElevation(tenantId, grant.userId, grant.grantedRole, grant.previousRole)
  }
  await setAccessWindow(tenantId, grant.userId, grant.expiresAt)

  const updated = await requireGrant(tenantId, id)
  await recordSecurityEvent({
    tenantId,
    category: auditCategory(grant.kind),
    action: "request_approved",
    outcome: "approved",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    subjectEmail: grant.userEmail,
    detail: { grantId: id, grantedRole: grant.grantedRole, expiresAt: grant.expiresAt },
  })
  await notify(updated, `Break-glass access for ${grant.userName} approved`, actor)
  return updated
}

export async function rejectGrant(tenantId: number, id: number, actor: Actor, reason: string): Promise<AccessGrant> {
  const grant = await requireGrant(tenantId, id)
  if (grant.status !== "pending") throw new TemporaryAccessError("Only a pending request can be rejected", 409)
  await query(
    `UPDATE \`temporary_access_grants\`
       SET status = 'rejected', approver_user_id = ?, approver_name = ?, ended_at = NOW(), end_reason = ?
     WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
    [actor.userId, actor.name ?? null, String(reason ?? "").slice(0, 300) || "Rejected", id, tenantId],
  )
  const updated = await requireGrant(tenantId, id)
  await recordSecurityEvent({
    tenantId,
    category: auditCategory(grant.kind),
    action: "request_rejected",
    outcome: "rejected",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    subjectEmail: grant.userEmail,
    detail: { grantId: id, reason },
  })
  await notify(updated, `Break-glass access for ${grant.userName} rejected`, actor)
  return updated
}

/** Revoke an active (or pending) grant early, reverting any elevation. */
export async function revokeGrant(tenantId: number, id: number, actor: Actor, reason: string): Promise<AccessGrant> {
  const grant = await requireGrant(tenantId, id)
  if (grant.status !== "active" && grant.status !== "pending") {
    throw new TemporaryAccessError("Only an active or pending grant can be revoked", 409)
  }
  await endGrant(grant, "revoked", String(reason ?? "").slice(0, 300) || "Revoked by administrator", actor)
  return requireGrant(tenantId, id)
}

/**
 * End a grant (revoke or expire): reverse the elevation and access window,
 * mark the row, and audit + notify. Shared by manual revoke and the scheduler.
 */
async function endGrant(grant: AccessGrant, status: "revoked" | "expired", reason: string, actor: Actor) {
  const wasActive = grant.status === "active"
  await query(
    `UPDATE \`temporary_access_grants\`
       SET status = ?, ended_at = NOW(), end_reason = ?
     WHERE id = ? AND tenant_id = ? AND status IN ('active','pending')`,
    [status, reason, grant.id, grant.tenantId],
  )

  if (wasActive) {
    if (grant.grantedRole && grant.previousRole) {
      await restoreElevation(grant.tenantId, grant.userId, grant.grantedRole, grant.previousRole)
    }
    await clearAccessWindow(grant.tenantId, grant.userId, grant.expiresAt)
  }

  await recordSecurityEvent({
    tenantId: grant.tenantId,
    category: auditCategory(grant.kind),
    action: status === "revoked" ? "grant_revoked" : "grant_expired",
    outcome: status === "revoked" ? "revoked" : "expired",
    actorUserId: actor.userId || null,
    actorName: actor.name ?? null,
    subjectEmail: grant.userEmail,
    detail: { grantId: grant.id, reason, grantedRole: grant.grantedRole },
  })
  await notify(
    grant,
    `${grant.kind === "break_glass" ? "Break-glass" : "Temporary"} access for ${grant.userName} ${status}`,
    actor,
  )
}

// ---------------------------------------------------------------------------
// Scheduler — automatic revocation & scheduled activation
// ---------------------------------------------------------------------------

/**
 * Drive all due state transitions for the CURRENT tenant scope. Invoked by the
 * `/api/cron/temporary-access` job inside `forEachActiveTenant`. Idempotent —
 * re-running once everything is up to date changes nothing.
 */
export async function runDueTransitionsForTenant(tenantId: number): Promise<{ activated: number; expired: number }> {
  await ensureTemporaryAccessSchema()
  const rows = await query<GrantRow[]>(
    `${SELECT} WHERE tenant_id = ? AND status IN ('pending','active')`,
    [tenantId],
  )
  const grants = rows.map(toPublic)
  const core: CoreGrant[] = grants.map((g) => ({
    id: g.id,
    kind: g.kind,
    status: g.status,
    startAt: new Date(g.startAt).getTime(),
    expiresAt: new Date(g.expiresAt).getTime(),
  }))
  const { toActivate, toExpire } = computeDueTransitions(core, Date.now())
  const byId = new Map(grants.map((g) => [g.id, g]))
  const systemActor: Actor = { userId: 0, name: "Automatic scheduler" }

  let activated = 0
  for (const id of toActivate) {
    const grant = byId.get(id)
    if (!grant) continue
    try {
      await activateScheduledGrant(grant)
      activated++
    } catch (err) {
      console.error(`[temporary-access] activate failed for grant ${id}:`, err)
    }
  }

  let expired = 0
  for (const id of toExpire) {
    const grant = byId.get(id)
    if (!grant) continue
    try {
      await endGrant(grant, "expired", "Automatically expired at end of window", systemActor)
      expired++
    } catch (err) {
      console.error(`[temporary-access] expire failed for grant ${id}:`, err)
    }
  }

  return { activated, expired }
}

/** Activate a pending temporary grant whose scheduled start has arrived. */
async function activateScheduledGrant(grant: AccessGrant) {
  await query(
    `UPDATE \`temporary_access_grants\` SET status = 'active', activated_at = NOW()
       WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
    [grant.id, grant.tenantId],
  )
  if (grant.grantedRole && grant.previousRole) {
    await applyElevation(grant.tenantId, grant.userId, grant.grantedRole, grant.previousRole)
  }
  await setAccessWindow(grant.tenantId, grant.userId, grant.expiresAt)
  await recordSecurityEvent({
    tenantId: grant.tenantId,
    category: auditCategory(grant.kind),
    action: "grant_activated",
    outcome: "activated",
    actorUserId: null,
    actorName: "Automatic scheduler",
    subjectEmail: grant.userEmail,
    detail: { grantId: grant.id, grantedRole: grant.grantedRole, expiresAt: grant.expiresAt },
  })
}

function sqlDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}
