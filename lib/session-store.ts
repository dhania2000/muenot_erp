import "server-only"
/**
 * SPEC 61 — Server-side session store.
 * ---------------------------------------------------------------------------
 * lib/auth.ts issues a stateless, signed JWT cookie: the token alone is
 * sufficient to authenticate a request, which means there was previously no
 * server-side record to list "who is signed in", revoke a single device, or
 * enforce a concurrent-session cap. This module adds that record WITHOUT
 * replacing the JWT: the token still carries the verified claims (so every
 * request stays a single fast signature check), but it now also carries a
 * `sid` (session id / jti). On each request the middleware/guard layer can
 * check that `sid` against this table; if the row is missing or revoked, the
 * (still cryptographically valid) token is treated as signed out.
 *
 * Self-heals at runtime (same pattern as lib/secrets/store.ts) so existing
 * databases converge without a manual migration step.
 */
import { randomUUID } from "node:crypto"
import { query } from "@/lib/db"

export type SessionRow = {
  id: number
  session_id: string
  user_id: number
  tenant_id: number | null
  ip_address: string | null
  user_agent: string | null
  login_method: string
  created_at: string
  last_active_at: string
  expires_at: string
  revoked_at: string | null
  revoked_reason: string | null
}

export type PublicSession = {
  id: number
  sessionId: string
  userId: number
  userName: string
  userEmail: string
  ipAddress: string | null
  device: string
  browser: string
  loginMethod: string
  createdAt: string
  lastActiveAt: string
  expiresAt: string
  isCurrent: boolean
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`user_sessions\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`session_id\` VARCHAR(64) NOT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`ip_address\` VARCHAR(64) DEFAULT NULL,
      \`user_agent\` VARCHAR(500) DEFAULT NULL,
      \`login_method\` VARCHAR(20) NOT NULL DEFAULT 'password',
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_active_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`expires_at\` DATETIME NOT NULL,
      \`revoked_at\` DATETIME DEFAULT NULL,
      \`revoked_reason\` VARCHAR(60) DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_user_sessions_session_id\` (\`session_id\`),
      KEY \`idx_user_sessions_user\` (\`user_id\`),
      KEY \`idx_user_sessions_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureSessionSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

/** Generate a new opaque session id (`jti`) to embed in the signed JWT. */
export function newSessionId(): string {
  return randomUUID()
}

/**
 * Record a new session at login time. Also enforces the concurrent-session
 * cap (SPEC 61 policy) by revoking the oldest active sessions for the user
 * once the limit would be exceeded, so a stolen/forgotten device cannot
 * accumulate unlimited standing sessions.
 */
export async function createSession(input: {
  sessionId: string
  userId: number
  tenantId?: number | null
  ipAddress?: string | null
  userAgent?: string | null
  loginMethod?: string
  expiresAt: Date
  concurrentLimit?: number
}): Promise<void> {
  await ensureSessionSchema()
  await query(
    `INSERT INTO \`user_sessions\`
       (\`session_id\`, \`user_id\`, \`tenant_id\`, \`ip_address\`, \`user_agent\`, \`login_method\`, \`expires_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sessionId,
      input.userId,
      input.tenantId ?? null,
      input.ipAddress ?? null,
      input.userAgent ? input.userAgent.slice(0, 500) : null,
      input.loginMethod ?? "password",
      input.expiresAt,
    ],
  )

  if (input.concurrentLimit && input.concurrentLimit > 0) {
    const active = await query<{ session_id: string }[]>(
      `SELECT \`session_id\` FROM \`user_sessions\`
       WHERE \`user_id\` = ? AND \`revoked_at\` IS NULL AND \`expires_at\` > NOW()
       ORDER BY \`last_active_at\` DESC`,
      [input.userId],
    )
    const overflow = active.slice(input.concurrentLimit)
    for (const row of overflow) {
      await revokeSession(row.session_id, "concurrent_limit")
    }
  }
}

/**
 * Validate a session id from a verified JWT against the store. Returns false
 * (sign the user out) when the row is missing, revoked, or expired — this is
 * the enforcement hook that makes revocation and the concurrent-session cap
 * actually take effect despite the JWT itself still verifying cryptographically.
 * Best-effort: a store outage never blocks a request (fails open), matching
 * the rest of the platform's DB-degradation posture.
 */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  if (!sessionId) return true
  try {
    await ensureSessionSchema()
    const rows = await query<{ revoked_at: string | null; expires_at: string }[]>(
      `SELECT \`revoked_at\`, \`expires_at\` FROM \`user_sessions\` WHERE \`session_id\` = ? LIMIT 1`,
      [sessionId],
    )
    const row = rows[0]
    if (!row) return true // legacy token issued before this store existed
    if (row.revoked_at) return false
    if (new Date(row.expires_at).getTime() < Date.now()) return false
    return true
  } catch (err) {
    console.error("[v0] session store: liveness check failed, failing open", err)
    return true
  }
}

/** Best-effort heartbeat so "last active" reflects real usage, not just login time. */
export async function touchSession(sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    await ensureSessionSchema()
    await query(
      `UPDATE \`user_sessions\` SET \`last_active_at\` = CURRENT_TIMESTAMP
       WHERE \`session_id\` = ? AND \`revoked_at\` IS NULL`,
      [sessionId],
    )
  } catch (err) {
    console.error("[v0] session store: touch failed", err)
  }
}

export async function revokeSession(sessionId: string, reason = "manual"): Promise<void> {
  await ensureSessionSchema()
  await query(
    `UPDATE \`user_sessions\` SET \`revoked_at\` = CURRENT_TIMESTAMP, \`revoked_reason\` = ?
     WHERE \`session_id\` = ? AND \`revoked_at\` IS NULL`,
    [reason.slice(0, 60), sessionId],
  )
}

/** Revoke every active session for a user (e.g. "sign out all devices"), optionally keeping one. */
export async function revokeAllSessionsForUser(
  userId: number,
  opts: { exceptSessionId?: string; reason?: string } = {},
): Promise<number> {
  await ensureSessionSchema()
  const params: unknown[] = [opts.reason?.slice(0, 60) ?? "sign_out_all", userId]
  let sql = `UPDATE \`user_sessions\` SET \`revoked_at\` = CURRENT_TIMESTAMP, \`revoked_reason\` = ?
             WHERE \`user_id\` = ? AND \`revoked_at\` IS NULL`
  if (opts.exceptSessionId) {
    sql += ` AND \`session_id\` != ?`
    params.push(opts.exceptSessionId)
  }
  const result = await query<{ affectedRows?: number } | any>(sql, params)
  return (result as any)?.affectedRows ?? 0
}

/**
 * SPEC 63 — device recognition for "block unknown devices" access policies.
 * A device is considered known when the user has signed in from the same
 * user-agent before (any prior session, including expired/revoked ones).
 * Returns null when it cannot be determined (no user-agent, or store error) so
 * a device-trust policy condition safely does not match rather than locking a
 * user out on missing data.
 */
export async function isKnownDevice(userId: number, userAgent: string | null): Promise<boolean | null> {
  if (!userAgent) return null
  try {
    await ensureSessionSchema()
    const rows = await query<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM \`user_sessions\` WHERE \`user_id\` = ? AND \`user_agent\` = ? LIMIT 1`,
      [userId, userAgent.slice(0, 500)],
    )
    return Number(rows[0]?.n ?? 0) > 0
  } catch (err) {
    console.error("[v0] session store: known-device check failed", err)
    return null
  }
}

function parseUserAgent(ua: string | null): { device: string; browser: string } {
  if (!ua) return { device: "Unknown device", browser: "Unknown browser" }
  const isMobile = /Mobile|Android|iPhone/i.test(ua)
  let os = "Unknown OS"
  if (/Windows/i.test(ua)) os = "Windows"
  else if (/Mac OS X/i.test(ua)) os = "macOS"
  else if (/Linux/i.test(ua)) os = "Linux"
  else if (/Android/i.test(ua)) os = "Android"
  else if (/iPhone|iPad|iOS/i.test(ua)) os = "iOS"

  let browser = "Unknown browser"
  if (/Edg\//i.test(ua)) browser = "Edge"
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = "Chrome"
  else if (/Firefox\//i.test(ua)) browser = "Firefox"
  else if (/Safari\//i.test(ua)) browser = "Safari"

  return { device: `${isMobile ? "Mobile" : "Desktop"} · ${os}`, browser }
}

/** All active (non-revoked, non-expired) sessions for a tenant, newest activity first. */
export async function listActiveSessions(
  tenantId: number | null,
  currentSessionId?: string,
): Promise<PublicSession[]> {
  await ensureSessionSchema()
  const rows = await query<(SessionRow & { name: string; email: string })[]>(
    `SELECT s.*, u.name, u.email FROM \`user_sessions\` s
     JOIN \`users\` u ON u.id = s.user_id
     WHERE s.revoked_at IS NULL AND s.expires_at > NOW() ${tenantId != null ? "AND s.tenant_id = ?" : ""}
     ORDER BY s.last_active_at DESC`,
    tenantId != null ? [tenantId] : [],
  )
  return rows.map((r) => {
    const { device, browser } = parseUserAgent(r.user_agent)
    return {
      id: r.id,
      sessionId: r.session_id,
      userId: r.user_id,
      userName: r.name,
      userEmail: r.email,
      ipAddress: r.ip_address,
      device,
      browser,
      loginMethod: r.login_method,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      expiresAt: r.expires_at,
      isCurrent: currentSessionId != null && r.session_id === currentSessionId,
    }
  })
}
