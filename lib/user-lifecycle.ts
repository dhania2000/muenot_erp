import "server-only"
/**
 * SPEC 14 — User lifecycle: the DB layer.
 * ---------------------------------------------------------------------------
 * Drives the pure state model (lib/user-lifecycle-core.ts) against the `users`
 * table plus a handful of supporting tables. Follows the house pattern used by
 * lib/tenant-onboarding.ts and lib/platform-roles.ts:
 *   - a self-healing schema (`ensureUserLifecycleSchema`) so existing installs
 *     converge with no manual migration (mirrors the 2026-11-14 migration),
 *   - explicit `tenant_id` predicates on every read/write (this module is
 *     called from tenant-admin routes that pass their effective tenant id), so
 *     one tenant can never see or mutate another's users,
 *   - an append-only `user_lifecycle_events` audit for the console.
 *
 * Every workflow the spec names lives here: invitation, activation,
 * verification, role & department assignment, suspension, temporary access,
 * password reset, MFA, offboarding / deactivation and data-ownership transfer.
 */
import { pool, query } from "@/lib/db"
import { hashPassword, generateTempPassword } from "@/lib/password"
import {
  type LifecycleAction,
  type LifecycleState,
  statusForLifecycle,
  validateAction,
} from "@/lib/user-lifecycle-core"
import {
  buildOtpAuthUrl,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  normalizeBackupCode,
  verifyTotp,
} from "@/lib/mfa"
import crypto from "crypto"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class LifecycleError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "LifecycleError"
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumn(table: string, column: string, def: string): Promise<void> {
  if (!(await columnExists(table, column))) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`)
  }
}

async function runEnsure(): Promise<void> {
  // --- Lifecycle columns on the existing users table (all additive/nullable) ---
  await addColumn(
    "users",
    "lifecycle_state",
    "ENUM('invited','active','suspended','deactivated') NOT NULL DEFAULT 'active' AFTER `status`",
  )
  await addColumn("users", "email_verified_at", "DATETIME DEFAULT NULL")
  await addColumn("users", "activated_at", "DATETIME DEFAULT NULL")
  await addColumn("users", "invited_at", "DATETIME DEFAULT NULL")
  await addColumn("users", "invited_by", "INT UNSIGNED DEFAULT NULL")
  await addColumn("users", "suspended_at", "DATETIME DEFAULT NULL")
  await addColumn("users", "suspended_reason", "VARCHAR(300) DEFAULT NULL")
  await addColumn("users", "deactivated_at", "DATETIME DEFAULT NULL")
  await addColumn("users", "deactivated_reason", "VARCHAR(300) DEFAULT NULL")
  // Temporary access: when set and in the past the user cannot sign in.
  await addColumn("users", "access_expires_at", "DATETIME DEFAULT NULL")
  // MFA (TOTP).
  await addColumn("users", "mfa_enabled", "TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("users", "mfa_secret", "VARCHAR(64) DEFAULT NULL")
  await addColumn("users", "mfa_enrolled_at", "DATETIME DEFAULT NULL")

  // Backfill lifecycle_state for rows created before this column existed:
  // an inactive legacy account is treated as deactivated, everything else
  // active. Then align the derived status so the two never disagree.
  await query(
    `UPDATE \`users\` SET \`lifecycle_state\` = CASE WHEN \`status\` = 'inactive' THEN 'deactivated' ELSE 'active' END
      WHERE \`lifecycle_state\` IS NULL OR \`lifecycle_state\` = ''`,
  )
  // Existing active users are considered verified so the optional
  // email-verification policy can never lock out pre-existing accounts.
  await query(
    `UPDATE \`users\` SET \`email_verified_at\` = COALESCE(\`created_at\`, NOW())
      WHERE \`email_verified_at\` IS NULL AND \`lifecycle_state\` = 'active'`,
  )

  // --- Invitations ---
  await query(`
    CREATE TABLE IF NOT EXISTS \`user_invitations\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`user_id\` INT UNSIGNED DEFAULT NULL,
      \`email\` VARCHAR(190) NOT NULL,
      \`token_hash\` CHAR(64) NOT NULL,
      \`status\` ENUM('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
      \`invited_by\` INT UNSIGNED DEFAULT NULL,
      \`expires_at\` DATETIME NOT NULL,
      \`accepted_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_invitation_token\` (\`token_hash\`),
      KEY \`idx_invitation_tenant\` (\`tenant_id\`),
      KEY \`idx_invitation_user\` (\`user_id\`),
      KEY \`idx_invitation_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Email verification tokens ---
  await query(`
    CREATE TABLE IF NOT EXISTS \`user_email_verifications\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`token_hash\` CHAR(64) NOT NULL,
      \`consumed_at\` DATETIME DEFAULT NULL,
      \`expires_at\` DATETIME NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_email_verif_token\` (\`token_hash\`),
      KEY \`idx_email_verif_user\` (\`user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- MFA backup / recovery codes (stored hashed) ---
  await query(`
    CREATE TABLE IF NOT EXISTS \`user_mfa_backup_codes\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`code_hash\` CHAR(64) NOT NULL,
      \`used_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_mfa_backup_user\` (\`user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Append-only lifecycle audit ---
  await query(`
    CREATE TABLE IF NOT EXISTS \`user_lifecycle_events\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`user_id\` INT UNSIGNED DEFAULT NULL,
      \`action\` VARCHAR(48) NOT NULL,
      \`from_state\` VARCHAR(20) DEFAULT NULL,
      \`to_state\` VARCHAR(20) DEFAULT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_email\` VARCHAR(190) DEFAULT NULL,
      \`detail\` JSON DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_ule_tenant\` (\`tenant_id\`),
      KEY \`idx_ule_user\` (\`user_id\`),
      KEY \`idx_ule_action\` (\`action\`),
      KEY \`idx_ule_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // --- Data-ownership transfer records ---
  await query(`
    CREATE TABLE IF NOT EXISTS \`user_ownership_transfers\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`from_user_id\` INT UNSIGNED NOT NULL,
      \`to_user_id\` INT UNSIGNED NOT NULL,
      \`summary\` JSON DEFAULT NULL,
      \`rows_transferred\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_uot_tenant\` (\`tenant_id\`),
      KEY \`idx_uot_from\` (\`from_user_id\`),
      KEY \`idx_uot_to\` (\`to_user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureUserLifecycleSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Actor = { userId: number; email?: string | null }

export type LifecycleUser = {
  id: number
  tenantId: number | null
  name: string
  email: string
  role: "admin" | "employee"
  tenantRole: string
  lifecycleState: LifecycleState
  status: "active" | "inactive"
  emailVerifiedAt: string | null
  activatedAt: string | null
  invitedAt: string | null
  suspendedAt: string | null
  suspendedReason: string | null
  deactivatedAt: string | null
  deactivatedReason: string | null
  accessExpiresAt: string | null
  mfaEnabled: boolean
  mustChangePassword: boolean
  createdAt: string | null
}

function mapUser(r: any): LifecycleUser {
  return {
    id: Number(r.id),
    tenantId: r.tenant_id != null ? Number(r.tenant_id) : null,
    name: r.name ?? "",
    email: r.email ?? "",
    role: r.role === "admin" ? "admin" : "employee",
    tenantRole: r.tenant_role ?? "employee",
    lifecycleState: (r.lifecycle_state ?? "active") as LifecycleState,
    status: r.status === "active" ? "active" : "inactive",
    emailVerifiedAt: r.email_verified_at ?? null,
    activatedAt: r.activated_at ?? null,
    invitedAt: r.invited_at ?? null,
    suspendedAt: r.suspended_at ?? null,
    suspendedReason: r.suspended_reason ?? null,
    deactivatedAt: r.deactivated_at ?? null,
    deactivatedReason: r.deactivated_reason ?? null,
    accessExpiresAt: r.access_expires_at ?? null,
    mfaEnabled: Boolean(r.mfa_enabled),
    mustChangePassword: Boolean(r.must_change_password),
    createdAt: r.created_at ?? null,
  }
}

const USER_COLUMNS = `id, tenant_id, name, email, role, tenant_role, status, lifecycle_state,
  email_verified_at, activated_at, invited_at, suspended_at, suspended_reason,
  deactivated_at, deactivated_reason, access_expires_at, mfa_enabled, must_change_password, created_at`

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listLifecycleUsers(tenantId: number): Promise<LifecycleUser[]> {
  await ensureUserLifecycleSchema()
  const rows = await query<any[]>(
    `SELECT ${USER_COLUMNS} FROM \`users\` WHERE tenant_id = ?
      ORDER BY FIELD(lifecycle_state,'invited','suspended','active','deactivated'), name ASC`,
    [tenantId],
  )
  return rows.map(mapUser)
}

export async function getLifecycleUser(tenantId: number, userId: number): Promise<LifecycleUser | null> {
  await ensureUserLifecycleSchema()
  const rows = await query<any[]>(
    `SELECT ${USER_COLUMNS} FROM \`users\` WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [userId, tenantId],
  )
  return rows[0] ? mapUser(rows[0]) : null
}

/** Minimal snapshot the login gate needs (looked up by email, tenant-agnostic). */
export async function getLoginSnapshot(userId: number): Promise<{
  lifecycleState: LifecycleState
  accessExpiresAt: string | null
  emailVerifiedAt: string | null
  mfaEnabled: boolean
  mfaSecret: string | null
} | null> {
  await ensureUserLifecycleSchema()
  const rows = await query<any[]>(
    `SELECT lifecycle_state, access_expires_at, email_verified_at, mfa_enabled, mfa_secret
       FROM \`users\` WHERE id = ? LIMIT 1`,
    [userId],
  )
  const r = rows[0]
  if (!r) return null
  return {
    lifecycleState: (r.lifecycle_state ?? "active") as LifecycleState,
    accessExpiresAt: r.access_expires_at ?? null,
    emailVerifiedAt: r.email_verified_at ?? null,
    mfaEnabled: Boolean(r.mfa_enabled),
    mfaSecret: r.mfa_secret ?? null,
  }
}

export type LifecycleEvent = {
  id: number
  userId: number | null
  action: string
  fromState: string | null
  toState: string | null
  actorUserId: number | null
  actorEmail: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

export async function listLifecycleEvents(
  tenantId: number,
  opts: { userId?: number; limit?: number } = {},
): Promise<LifecycleEvent[]> {
  await ensureUserLifecycleSchema()
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200))
  const where = opts.userId ? "tenant_id = ? AND user_id = ?" : "tenant_id = ?"
  const params = opts.userId ? [tenantId, opts.userId, limit] : [tenantId, limit]
  const rows = await query<any[]>(
    `SELECT id, user_id, action, from_state, to_state, actor_user_id, actor_email, detail, created_at
       FROM \`user_lifecycle_events\` WHERE ${where} ORDER BY id DESC LIMIT ?`,
    params,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    userId: r.user_id != null ? Number(r.user_id) : null,
    action: r.action,
    fromState: r.from_state ?? null,
    toState: r.to_state ?? null,
    actorUserId: r.actor_user_id != null ? Number(r.actor_user_id) : null,
    actorEmail: r.actor_email ?? null,
    detail: parseJson(r.detail),
    createdAt: r.created_at,
  }))
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === "object") return v as Record<string, unknown>
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

async function logEvent(entry: {
  tenantId: number
  userId: number | null
  action: LifecycleAction | string
  fromState?: LifecycleState | null
  toState?: LifecycleState | null
  actor: Actor
  detail?: Record<string, unknown> | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO \`user_lifecycle_events\`
         (tenant_id, user_id, action, from_state, to_state, actor_user_id, actor_email, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.tenantId,
        entry.userId,
        entry.action,
        entry.fromState ?? null,
        entry.toState ?? null,
        entry.actor.userId,
        entry.actor.email ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ],
    )
  } catch (err) {
    console.error("[user-lifecycle] audit write failed:", err)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Load a user for mutation, scoped to the tenant. Throws 404 if not owned. */
async function requireUser(tenantId: number, userId: number): Promise<LifecycleUser> {
  const user = await getLifecycleUser(tenantId, userId)
  if (!user) throw new LifecycleError("User not found in this organization", 404)
  return user
}

/** Apply a validated lifecycle transition, keeping `status` in lock-step. */
async function setState(
  tenantId: number,
  userId: number,
  to: LifecycleState,
  extraSet: Record<string, any> = {},
): Promise<void> {
  const set = { lifecycle_state: to, status: statusForLifecycle(to), ...extraSet }
  const cols = Object.keys(set)
  await query(
    `UPDATE \`users\` SET ${cols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE id = ? AND tenant_id = ?`,
    [...cols.map((c) => set[c]), userId, tenantId],
  )
}

function newToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url")
  const hash = crypto.createHash("sha256").update(token).digest("hex")
  return { token, hash }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

// ---------------------------------------------------------------------------
// Phase 3 workflows — Invitation
// ---------------------------------------------------------------------------

export type InviteInput = {
  email: string
  name: string
  role?: "admin" | "employee"
  tenantRole?: "employee" | "module_admin" | "tenant_admin"
  designation?: string | null
  expiresInHours?: number
}

export type InviteResult = { user: LifecycleUser; token: string; expiresAt: string }

/**
 * Create an `invited` user and a single-use invitation token. The account
 * carries an unusable random password until the invite is accepted, so it can
 * never be signed into in the meantime. Re-inviting an email that already has a
 * pending invite is rejected; an existing active/suspended account is rejected.
 */
export async function inviteUser(tenantId: number, input: InviteInput, actor: Actor): Promise<InviteResult> {
  await ensureUserLifecycleSchema()
  const email = input.email.toLowerCase().trim()
  const name = input.name.trim()
  if (!EMAIL_RE.test(email)) throw new LifecycleError("A valid email address is required")
  if (!name) throw new LifecycleError("Name is required")

  const existing = await query<any[]>(`SELECT id, lifecycle_state, tenant_id FROM users WHERE email = ? LIMIT 1`, [
    email,
  ])
  if (existing[0]) {
    throw new LifecycleError("A user with this email already exists", 409)
  }

  const role = input.role === "admin" ? "admin" : "employee"
  const tenantRole = input.tenantRole ?? (role === "admin" ? "tenant_admin" : "employee")
  const expiresInHours = Math.max(1, Math.min(24 * 30, input.expiresInHours ?? 24 * 7))

  // Unusable placeholder secret — replaced when the invite is accepted.
  const placeholder = await hashPassword(crypto.randomBytes(24).toString("hex"))

  const conn = await pool.getConnection()
  let userId: number
  const { token, hash } = newToken()
  try {
    await conn.beginTransaction()
    const [res] = await conn.query<any>(
      `INSERT INTO users
         (tenant_id, name, email, password_hash, role, tenant_role, platform_role, designation,
          status, lifecycle_state, must_change_password, invited_at, invited_by)
       VALUES (?, ?, ?, ?, ?, ?, 'none', ?, 'inactive', 'invited', 1, NOW(), ?)`,
      [tenantId, name, email, placeholder, role, tenantRole, input.designation ?? null, actor.userId],
    )
    userId = Number(res.insertId)
    await conn.query(
      `INSERT INTO user_invitations (tenant_id, user_id, email, token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [tenantId, userId, email, hash, actor.userId, expiresInHours],
    )
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  await logEvent({
    tenantId,
    userId,
    action: "invite",
    toState: "invited",
    actor,
    detail: { email, role, tenantRole, expiresInHours },
  })

  const user = await requireUser(tenantId, userId)
  const expRows = await query<any[]>(
    `SELECT expires_at FROM user_invitations WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [userId],
  )
  return { user, token, expiresAt: expRows[0]?.expires_at ?? "" }
}

export type PendingInvitation = {
  email: string
  name: string
  tenantId: number | null
  expired: boolean
}

/** Resolve a raw invitation token to its (still-pending) invite, or null. */
export async function getInvitationByToken(token: string): Promise<PendingInvitation | null> {
  await ensureUserLifecycleSchema()
  const hash = hashToken(token)
  const rows = await query<any[]>(
    `SELECT i.email, i.status, i.expires_at, i.tenant_id, u.name
       FROM user_invitations i JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = ? LIMIT 1`,
    [hash],
  )
  const r = rows[0]
  if (!r || r.status !== "pending") return null
  return {
    email: r.email,
    name: r.name ?? "",
    tenantId: r.tenant_id != null ? Number(r.tenant_id) : null,
    expired: new Date(r.expires_at).getTime() <= Date.now(),
  }
}

/**
 * Accept an invitation: set the chosen password, activate the account and mark
 * the email verified (clicking the link proves control of the inbox). Consumes
 * the token so the link cannot be replayed.
 */
export async function acceptInvitation(token: string, input: { name?: string; password: string }): Promise<void> {
  await ensureUserLifecycleSchema()
  const hash = hashToken(token)
  const rows = await query<any[]>(
    `SELECT id, user_id, tenant_id, status, expires_at FROM user_invitations WHERE token_hash = ? LIMIT 1`,
    [hash],
  )
  const invite = rows[0]
  if (!invite || invite.status !== "pending") throw new LifecycleError("This invitation is no longer valid", 410)
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    await query(`UPDATE user_invitations SET status = 'expired' WHERE id = ?`, [invite.id])
    throw new LifecycleError("This invitation has expired. Ask your administrator to send a new one.", 410)
  }
  if (!input.password || input.password.length < 8) {
    throw new LifecycleError("Choose a password of at least 8 characters")
  }

  const passwordHash = await hashPassword(input.password)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE users
          SET password_hash = ?, must_change_password = 0, lifecycle_state = 'active', status = 'active',
              activated_at = NOW(), email_verified_at = COALESCE(email_verified_at, NOW()),
              name = COALESCE(NULLIF(?, ''), name)
        WHERE id = ?`,
      [passwordHash, input.name?.trim() ?? "", invite.user_id],
    )
    await conn.query(`UPDATE user_invitations SET status = 'accepted', accepted_at = NOW() WHERE id = ?`, [invite.id])
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  await logEvent({
    tenantId: Number(invite.tenant_id),
    userId: Number(invite.user_id),
    action: "activate",
    fromState: "invited",
    toState: "active",
    actor: { userId: Number(invite.user_id) },
    detail: { via: "invitation" },
  })
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function createEmailVerification(tenantId: number, userId: number): Promise<string> {
  await ensureUserLifecycleSchema()
  const { token, hash } = newToken()
  await query(
    `INSERT INTO user_email_verifications (tenant_id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 48 HOUR))`,
    [tenantId, userId, hash],
  )
  return token
}

export async function verifyEmail(token: string): Promise<void> {
  await ensureUserLifecycleSchema()
  const hash = hashToken(token)
  const rows = await query<any[]>(
    `SELECT id, user_id, tenant_id, consumed_at, expires_at FROM user_email_verifications WHERE token_hash = ? LIMIT 1`,
    [hash],
  )
  const rec = rows[0]
  if (!rec || rec.consumed_at) throw new LifecycleError("This verification link is no longer valid", 410)
  if (new Date(rec.expires_at).getTime() <= Date.now()) {
    throw new LifecycleError("This verification link has expired", 410)
  }
  await query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = ?`, [rec.user_id])
  await query(`UPDATE user_email_verifications SET consumed_at = NOW() WHERE id = ?`, [rec.id])
  await logEvent({
    tenantId: Number(rec.tenant_id),
    userId: Number(rec.user_id),
    action: "verify_email",
    actor: { userId: Number(rec.user_id) },
  })
}

// ---------------------------------------------------------------------------
// Suspension / reactivation / temporary access / offboarding
// ---------------------------------------------------------------------------

/** Run a state-moving action with the pure validator as the gate. */
async function transition(
  tenantId: number,
  userId: number,
  action: Extract<LifecycleAction, "suspend" | "reactivate" | "deactivate" | "rehire">,
  actor: Actor,
  extraSet: Record<string, any>,
  detail?: Record<string, unknown>,
): Promise<LifecycleUser> {
  const user = await requireUser(tenantId, userId)
  const check = validateAction(action, user.lifecycleState)
  if (!check.ok) throw new LifecycleError(check.reason, 409)
  const to = check.to! // transitioning actions always resolve a target
  await setState(tenantId, userId, to, extraSet)
  await logEvent({ tenantId, userId, action, fromState: user.lifecycleState, toState: to, actor, detail })
  return requireUser(tenantId, userId)
}

export function suspendUser(tenantId: number, userId: number, reason: string | null, actor: Actor) {
  return transition(
    tenantId,
    userId,
    "suspend",
    actor,
    { suspended_at: new Date(), suspended_reason: reason?.slice(0, 300) ?? null },
    { reason },
  )
}

export function reactivateUser(tenantId: number, userId: number, actor: Actor) {
  return transition(tenantId, userId, "reactivate", actor, {
    suspended_at: null,
    suspended_reason: null,
  })
}

/**
 * Grant time-bound access to an ACTIVE user (contractor, temporary elevation…).
 * Does not change the durable state — `evaluateLogin` treats a past expiry as a
 * block, so access simply lapses on its own with no background job.
 */
export async function grantTemporaryAccess(
  tenantId: number,
  userId: number,
  expiresAt: Date,
  actor: Actor,
): Promise<LifecycleUser> {
  const user = await requireUser(tenantId, userId)
  if (user.lifecycleState !== "active") {
    throw new LifecycleError("Temporary access can only be granted to an active user", 409)
  }
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new LifecycleError("Temporary access must expire at a future date/time")
  }
  await query(`UPDATE users SET access_expires_at = ? WHERE id = ? AND tenant_id = ?`, [expiresAt, userId, tenantId])
  await logEvent({
    tenantId,
    userId,
    action: "grant_temp_access",
    actor,
    detail: { expiresAt: expiresAt.toISOString() },
  })
  return requireUser(tenantId, userId)
}

export async function revokeTemporaryAccess(tenantId: number, userId: number, actor: Actor): Promise<LifecycleUser> {
  const user = await requireUser(tenantId, userId)
  await query(`UPDATE users SET access_expires_at = NULL WHERE id = ? AND tenant_id = ?`, [userId, tenantId])
  await logEvent({ tenantId, userId, action: "revoke_temp_access", actor })
  return user
}

export type DeactivateOptions = { reason?: string | null; transferToUserId?: number | null }

/**
 * Offboard / deactivate a user (the leaver flow). Optionally transfers the
 * leaver's owned records to another user in the same tenant BEFORE the state
 * flip, so nothing is orphaned. A deactivated user cannot sign in and can only
 * return via `rehireUser`.
 */
export async function deactivateUser(
  tenantId: number,
  userId: number,
  opts: DeactivateOptions,
  actor: Actor,
): Promise<{ user: LifecycleUser; transfer: OwnershipTransferResult | null }> {
  const user = await requireUser(tenantId, userId)
  const check = validateAction("deactivate", user.lifecycleState)
  if (!check.ok) throw new LifecycleError(check.reason, 409)

  let transfer: OwnershipTransferResult | null = null
  if (opts.transferToUserId) {
    transfer = await transferDataOwnership(tenantId, userId, opts.transferToUserId, actor)
  }

  await setState(tenantId, userId, "deactivated", {
    deactivated_at: new Date(),
    deactivated_reason: opts.reason?.slice(0, 300) ?? null,
    access_expires_at: null,
  })
  await logEvent({
    tenantId,
    userId,
    action: "deactivate",
    fromState: user.lifecycleState,
    toState: "deactivated",
    actor,
    detail: { reason: opts.reason ?? null, transferredTo: opts.transferToUserId ?? null },
  })
  return { user: await requireUser(tenantId, userId), transfer }
}

/** Rehire — bring a deactivated user back as active (requires a fresh password reset). */
export async function rehireUser(tenantId: number, userId: number, actor: Actor): Promise<LifecycleUser> {
  return transition(tenantId, userId, "rehire", actor, {
    deactivated_at: null,
    deactivated_reason: null,
  })
}

// ---------------------------------------------------------------------------
// Role & department assignment (Phase 3 integration)
// ---------------------------------------------------------------------------

/** Assign an org unit (department) to a user, tenant-scoped and idempotent. */
export async function assignDepartment(
  tenantId: number,
  userId: number,
  orgUnitId: number,
  opts: { title?: string | null; isPrimary?: boolean },
  actor: Actor,
): Promise<void> {
  await ensureUserLifecycleSchema()
  await requireUser(tenantId, userId)
  const unit = await query<any[]>(`SELECT id, name FROM org_units WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    orgUnitId,
    tenantId,
  ])
  if (!unit[0]) throw new LifecycleError("Department (org unit) not found", 404)

  if (opts.isPrimary) {
    await query(`UPDATE org_unit_assignments SET is_primary = 0 WHERE tenant_id = ? AND user_id = ?`, [
      tenantId,
      userId,
    ])
  }
  await query(
    `INSERT INTO org_unit_assignments (tenant_id, org_unit_id, user_id, assignment_title, is_primary, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE assignment_title = VALUES(assignment_title), is_primary = VALUES(is_primary)`,
    [tenantId, orgUnitId, userId, opts.title?.trim() || null, opts.isPrimary ? 1 : 0, actor.userId],
  )
  await logEvent({
    tenantId,
    userId,
    action: "assign_department",
    actor,
    detail: { orgUnitId, unit: unit[0].name, isPrimary: Boolean(opts.isPrimary) },
  })
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/** Admin-initiated reset: issue a temp password the user must change at next login. */
export async function adminResetPassword(
  tenantId: number,
  userId: number,
  actor: Actor,
): Promise<{ tempPassword: string }> {
  const user = await requireUser(tenantId, userId)
  if (user.lifecycleState === "deactivated") {
    throw new LifecycleError("Cannot reset the password of a deactivated user. Rehire them first.", 409)
  }
  const tempPassword = generateTempPassword(12)
  const passwordHash = await hashPassword(tempPassword)
  await query(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND tenant_id = ?`, [
    passwordHash,
    userId,
    tenantId,
  ])
  await logEvent({ tenantId, userId, action: "reset_password", actor })
  return { tempPassword }
}

// ---------------------------------------------------------------------------
// MFA (TOTP) enrollment lifecycle
// ---------------------------------------------------------------------------

export type MfaEnrollment = { secret: string; otpauthUrl: string }

/**
 * Begin TOTP enrollment: mint a secret and stage it on the user WITHOUT
 * enabling MFA yet. Enrollment is only completed (and enforced at login) once
 * the user proves possession via `confirmMfaEnrollment`.
 */
export async function beginMfaEnrollment(
  tenantId: number,
  userId: number,
  issuer: string,
): Promise<MfaEnrollment> {
  const user = await requireUser(tenantId, userId)
  if (user.mfaEnabled) throw new LifecycleError("MFA is already enabled for this account", 409)
  const secret = generateTotpSecret()
  await query(`UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ? AND tenant_id = ?`, [
    secret,
    userId,
    tenantId,
  ])
  return { secret, otpauthUrl: buildOtpAuthUrl(secret, user.email, issuer) }
}

/** Confirm enrollment with a live code; enables MFA and returns backup codes. */
export async function confirmMfaEnrollment(
  tenantId: number,
  userId: number,
  code: string,
  actor: Actor,
): Promise<{ backupCodes: string[] }> {
  await ensureUserLifecycleSchema()
  const rows = await query<any[]>(`SELECT mfa_secret, mfa_enabled FROM users WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    userId,
    tenantId,
  ])
  const r = rows[0]
  if (!r || !r.mfa_secret) throw new LifecycleError("Start MFA enrollment before confirming", 409)
  if (r.mfa_enabled) throw new LifecycleError("MFA is already enabled", 409)
  if (!verifyTotp(r.mfa_secret, code)) throw new LifecycleError("That code is not valid. Try again.", 400)

  const codes = generateBackupCodes()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`UPDATE users SET mfa_enabled = 1, mfa_enrolled_at = NOW() WHERE id = ?`, [userId])
    await conn.query(`DELETE FROM user_mfa_backup_codes WHERE user_id = ?`, [userId])
    for (const code of codes) {
      await conn.query(`INSERT INTO user_mfa_backup_codes (user_id, code_hash) VALUES (?, ?)`, [
        userId,
        hashBackupCode(code),
      ])
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
  await logEvent({ tenantId, userId, action: "enroll_mfa", actor })
  return { backupCodes: codes }
}

/** Disable MFA (self-service or admin), clearing the secret and backup codes. */
export async function disableMfa(tenantId: number, userId: number, actor: Actor): Promise<void> {
  await requireUser(tenantId, userId)
  await query(
    `UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_enrolled_at = NULL WHERE id = ? AND tenant_id = ?`,
    [userId, tenantId],
  )
  await query(`DELETE FROM user_mfa_backup_codes WHERE user_id = ?`, [userId])
  await logEvent({
    tenantId,
    userId,
    action: actor.userId === userId ? "disable_mfa" : "reset_mfa",
    actor,
  })
}

/**
 * Consume a live TOTP code OR a one-time backup code for a user at login.
 * Used by the auth route after the password check when MFA is enabled.
 */
export async function consumeMfaChallenge(userId: number, code: string): Promise<boolean> {
  await ensureUserLifecycleSchema()
  const rows = await query<any[]>(`SELECT mfa_secret FROM users WHERE id = ? LIMIT 1`, [userId])
  const secret = rows[0]?.mfa_secret
  if (secret && verifyTotp(secret, code)) return true

  // Fall back to a single-use backup code.
  const hash = hashBackupCode(code)
  if (!normalizeBackupCode(code)) return false
  const res = await query<any>(
    `UPDATE user_mfa_backup_codes SET used_at = NOW() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    [userId, hash],
  )
  return Number(res?.affectedRows ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Data-ownership transfer
// ---------------------------------------------------------------------------

/**
 * The set of tenant-scoped ownership columns reassigned when a user leaves.
 * Each entry is guarded by an information_schema existence check at run time,
 * so the transfer is resilient to modules that are absent in a given install
 * and never fails because a table or column does not exist.
 */
export const OWNERSHIP_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "sales_leads", column: "owner_id" },
  { table: "sales_leads", column: "assigned_to" },
  { table: "sales_deals", column: "owner_id" },
  { table: "sales_quotations", column: "owner_id" },
  { table: "hr_employees", column: "manager_user_id" },
  { table: "finance_invoices", column: "owner_id" },
  { table: "journal_entries", column: "created_by" },
  { table: "org_units", column: "head_user_id" },
  { table: "tasks", column: "assigned_to" },
  { table: "projects", column: "owner_id" },
]

export type OwnershipTransferResult = {
  rowsTransferred: number
  perColumn: Array<{ table: string; column: string; rows: number }>
}

async function tableColumnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function tableHasColumn(table: string, column: string): Promise<boolean> {
  return tableColumnExists(table, column)
}

/**
 * Reassign every owned record from one user to another within a tenant. Only
 * columns that (a) exist and (b) whose table is tenant-scoped are touched, and
 * every UPDATE is constrained by `tenant_id`, so a transfer can never rewrite
 * another tenant's data.
 */
export async function transferDataOwnership(
  tenantId: number,
  fromUserId: number,
  toUserId: number,
  actor: Actor,
): Promise<OwnershipTransferResult> {
  await ensureUserLifecycleSchema()
  if (fromUserId === toUserId) throw new LifecycleError("Choose a different user to receive ownership")
  const to = await getLifecycleUser(tenantId, toUserId)
  if (!to) throw new LifecycleError("Recipient user not found in this organization", 404)
  if (to.lifecycleState === "deactivated") {
    throw new LifecycleError("Cannot transfer ownership to a deactivated user", 409)
  }

  const perColumn: Array<{ table: string; column: string; rows: number }> = []
  let total = 0
  for (const { table, column } of OWNERSHIP_COLUMNS) {
    if (!(await tableHasColumn(table, column))) continue
    const hasTenant = await tableHasColumn(table, "tenant_id")
    // Only rewrite rows we can prove belong to this tenant.
    if (!hasTenant) continue
    const res = await query<any>(
      `UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ? AND tenant_id = ?`,
      [toUserId, fromUserId, tenantId],
    )
    const rows = Number(res?.affectedRows ?? 0)
    if (rows > 0) {
      perColumn.push({ table, column, rows })
      total += rows
    }
  }

  await query(
    `INSERT INTO user_ownership_transfers (tenant_id, from_user_id, to_user_id, summary, rows_transferred, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tenantId, fromUserId, toUserId, JSON.stringify(perColumn), total, actor.userId],
  )
  await logEvent({
    tenantId,
    userId: fromUserId,
    action: "transfer_ownership",
    actor,
    detail: { toUserId, rowsTransferred: total, perColumn },
  })
  return { rowsTransferred: total, perColumn }
}
