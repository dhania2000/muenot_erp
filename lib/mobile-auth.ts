import "server-only"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { SignJWT, jwtVerify } from "jose"
import { query, withTransaction } from "@/lib/db"
import { verifyPassword } from "@/lib/password"
import { checkLockout, recordFailedLogin, recordSuccessfulLogin } from "@/lib/password-policy"
import { getLoginSnapshot } from "@/lib/user-lifecycle"
import { evaluateLogin } from "@/lib/user-lifecycle-core"
import { getPublicSettings } from "@/lib/settings/server"
import { requiresMfaByPolicy } from "@/lib/mfa-policy"
import { getStoredRoles } from "@/lib/platform-roles"
import { getTenantById, type Tenant } from "@/lib/tenant-service"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"

const ACCESS_SECONDS = 15 * 60
const REFRESH_DAYS = 30
const AUDIENCE = "muenot-shopkeeper-mobile"

export type MobilePrincipal = { userId: number; tenantId: number; name: string; email: string; role: "admin" | "employee"; tenantRole: string; sessionId: string }
type Claims = MobilePrincipal & { typ: "mobile_access" }

function key() {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error("Mobile authentication is unavailable")
  return new TextEncoder().encode(secret)
}
function refreshHash(token: string) { return createHash("sha256").update(token).digest("hex") }
function cleanDevice(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) || null : null }
function publicUser(row: any) { return { id: Number(row.id), name: row.name, email: row.email, role: row.role } }

let ensured: Promise<void> | undefined
export function ensureMobileAuthSchema() {
  return ensured ??= query(`CREATE TABLE IF NOT EXISTS mobile_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, session_id VARCHAR(64) NOT NULL, tenant_id INT UNSIGNED NOT NULL,
    user_id INT UNSIGNED NOT NULL, refresh_token_hash CHAR(64) NOT NULL, device_name VARCHAR(120) NULL,
    platform VARCHAR(32) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL, revoked_at DATETIME NULL,
    revoked_reason VARCHAR(60) NULL, PRIMARY KEY(id), UNIQUE KEY uq_mobile_session(session_id), UNIQUE KEY uq_mobile_refresh(refresh_token_hash),
    KEY idx_mobile_sessions_user(user_id,tenant_id), CONSTRAINT fk_mobile_session_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_mobile_session_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(async () => {
    await query(`CREATE TABLE IF NOT EXISTS mobile_device_registrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
      mobile_session_id VARCHAR(64) NOT NULL, provider VARCHAR(20) NOT NULL DEFAULT 'fcm', token_hash CHAR(64) NOT NULL,
      token_encrypted TEXT NOT NULL, device_id VARCHAR(160) NULL, app_version VARCHAR(40) NULL, device_name VARCHAR(120) NULL, platform VARCHAR(32) NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
      last_seen_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY(id), UNIQUE KEY uq_mobile_device_token(tenant_id,token_hash), KEY idx_mobile_device_user(tenant_id,user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    const columns = await query<any[]>("SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='mobile_device_registrations'")
    const knownColumns = new Set(columns.map((row) => String(row.column_name)))
    if (!knownColumns.has("device_id")) await query("ALTER TABLE mobile_device_registrations ADD COLUMN device_id VARCHAR(160) NULL AFTER token_encrypted")
    if (!knownColumns.has("app_version")) await query("ALTER TABLE mobile_device_registrations ADD COLUMN app_version VARCHAR(40) NULL AFTER device_id")
    const indexes = await query<any[]>("SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='mobile_device_registrations'")
    if (!indexes.some((row) => row.index_name === "uq_mobile_device_installation")) await query("ALTER TABLE mobile_device_registrations ADD UNIQUE KEY uq_mobile_device_installation(tenant_id,user_id,device_id)")
    await query(`CREATE TABLE IF NOT EXISTS mobile_api_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
      session_id VARCHAR(64) NULL, action VARCHAR(80) NOT NULL, method VARCHAR(12) NULL, path VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(id), KEY idx_mobile_audit_tenant(tenant_id,created_at), KEY idx_mobile_audit_user(user_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  }).then(() => undefined).catch(error => { ensured = undefined; throw error })
}

async function issue(principal: Omit<MobilePrincipal, "sessionId">, deviceName?: string | null, platform?: string | null) {
  await ensureMobileAuthSchema()
  const sessionId = randomUUID()
  const refreshToken = randomBytes(48).toString("base64url")
  const refreshExpires = new Date(Date.now() + REFRESH_DAYS * 86400_000)
  await query("INSERT INTO mobile_sessions (session_id,tenant_id,user_id,refresh_token_hash,device_name,platform,expires_at) VALUES (?,?,?,?,?,?,?)", [sessionId, principal.tenantId, principal.userId, refreshHash(refreshToken), deviceName, platform, refreshExpires])
  const claims: Claims = { ...principal, sessionId, typ: "mobile_access" }
  const accessToken = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setAudience(AUDIENCE).setIssuedAt().setExpirationTime(`${ACCESS_SECONDS}s`).sign(key())
  return { accessToken, refreshToken, expiresIn: ACCESS_SECONDS, sessionId, refreshExpiresAt: refreshExpires.toISOString() }
}

export async function mobileLogin(request: Request, input: { email?: unknown; password?: unknown; mfaCode?: unknown; deviceName?: unknown; platform?: unknown }) {
  const ip = getClientIp(request)
  const rate = await checkRateLimit(`mobile-login:${ip}:${String(input.email ?? "").toLowerCase().slice(0, 190)}`, { max: 10, windowMs: 15 * 60_000 })
  if (!rate.allowed) return { ok: false as const, status: 429, error: "Too many sign-in attempts. Try again later.", retryAfter: rate.retryAfter }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : ""
  const password = typeof input.password === "string" ? input.password : ""
  if (!email || !password) return { ok: false as const, status: 400, error: "Email and password are required." }
  const rows = await query<any[]>("SELECT id,name,email,password_hash,role,status,tenant_id FROM users WHERE email = ? LIMIT 1", [email])
  const user = rows[0]
  if (user) {
    const lockout = await checkLockout(Number(user.id))
    if (lockout.locked) return { ok: false as const, status: 423, error: "Account is temporarily locked.", retryAfter: lockout.retryAfterSeconds }
  }
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    if (user) await recordFailedLogin(Number(user.id))
    return { ok: false as const, status: 401, error: "Invalid email or password." }
  }
  const snapshot = await getLoginSnapshot(Number(user.id))
  if (!snapshot || user.status !== "active") return { ok: false as const, status: 403, error: "This account is unavailable." }
  const settings = await getPublicSettings()
  const decision = evaluateLogin({ lifecycleState: snapshot.lifecycleState, accessExpiresAt: snapshot.accessExpiresAt, emailVerifiedAt: snapshot.emailVerifiedAt, mfaEnabled: snapshot.mfaEnabled, requireEmailVerification: Boolean(settings["security.require_email_verification"]) }, new Date())
  if (!decision.allowed) return { ok: false as const, status: 403, error: decision.reason }
  // Native MFA challenge is intentionally not bypassed. A mobile-specific TOTP
  // exchange can be added without weakening the password lifecycle.
  if (requiresMfaByPolicy({ role: user.role, mfaEnabled: snapshot.mfaEnabled, settings }) && !snapshot.mfaEnabled) return { ok: false as const, status: 403, error: "Your organization requires MFA enrollment before access is granted.", code: "MFA_ENROLLMENT_REQUIRED" }
  if (decision.requiresMfa) return { ok: false as const, status: 409, error: "MFA is required. Complete the configured MFA challenge before mobile sign-in.", code: "MFA_REQUIRED" }
  const tenant = user.tenant_id ? await getTenantById(Number(user.tenant_id)) : null
  if (!tenant || tenant.status !== "active") return { ok: false as const, status: 403, error: "This tenant is unavailable." }
  await recordSuccessfulLogin(Number(user.id))
  const roles = await getStoredRoles(Number(user.id))
  const principal = { userId: Number(user.id), tenantId: tenant.id, name: String(user.name), email: String(user.email), role: user.role as "admin" | "employee", tenantRole: roles?.tenantRole ?? (user.role === "admin" ? "tenant_admin" : "employee") }
  return { ok: true as const, user: publicUser(user), tenant, tokens: await issue(principal, cleanDevice(input.deviceName, 120), cleanDevice(input.platform, 32)) }
}

export async function refreshMobileSession(refreshToken: unknown) {
  if (typeof refreshToken !== "string" || refreshToken.length < 32) return { ok: false as const, status: 401, error: "Invalid refresh token." }
  await ensureMobileAuthSchema()
  const rows = await query<any[]>(`SELECT s.*,u.name,u.email,u.role,u.status AS user_status,t.status AS tenant_status
    FROM mobile_sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id JOIN tenants t ON t.id=s.tenant_id
    WHERE s.refresh_token_hash=? AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1`, [refreshHash(refreshToken)])
  const row = rows[0]
  if (!row || row.user_status !== "active" || row.tenant_status !== "active") return { ok: false as const, status: 401, error: "Session is no longer active." }
  const roles = await getStoredRoles(Number(row.user_id))
  await query("UPDATE mobile_sessions SET revoked_at=NOW(),revoked_reason='rotated' WHERE session_id=?", [row.session_id])
  const tokens = await issue({ userId: Number(row.user_id), tenantId: Number(row.tenant_id), name: row.name, email: row.email, role: row.role, tenantRole: roles?.tenantRole ?? (row.role === "admin" ? "tenant_admin" : "employee") }, row.device_name, row.platform)
  await query("UPDATE mobile_device_registrations SET mobile_session_id=? WHERE tenant_id=? AND user_id=? AND mobile_session_id=? AND enabled=1", [tokens.sessionId,row.tenant_id,row.user_id,row.session_id])
  return { ok: true as const, tokens }
}

export async function authenticateMobileRequest(request: Request): Promise<MobilePrincipal | null> {
  const raw = request.headers.get("authorization") || ""
  const token = /^Bearer\s+(.+)$/i.exec(raw)?.[1]
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, key(), { audience: AUDIENCE })
    if (payload.typ !== "mobile_access" || !payload.sessionId || !payload.userId || !payload.tenantId) return null
    await ensureMobileAuthSchema()
    const rows = await query<any[]>(`SELECT s.session_id,u.name,u.email,u.role,u.status AS user_status,t.status AS tenant_status
      FROM mobile_sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id JOIN tenants t ON t.id=s.tenant_id
      WHERE s.session_id=? AND s.user_id=? AND s.tenant_id=? AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1`, [String(payload.sessionId), Number(payload.userId), Number(payload.tenantId)])
    const row = rows[0]
    if (!row || row.user_status !== "active" || row.tenant_status !== "active") return null
    await query("UPDATE mobile_sessions SET last_active_at=NOW() WHERE session_id=?", [row.session_id]).catch(() => {})
    const roles = await getStoredRoles(Number(payload.userId))
    return { userId: Number(payload.userId), tenantId: Number(payload.tenantId), name: row.name, email: row.email, role: row.role, tenantRole: roles?.tenantRole ?? (row.role === "admin" ? "tenant_admin" : "employee"), sessionId: row.session_id }
  } catch { return null }
}

export async function revokeMobileSession(sessionId: string, userId: number, reason = "logout", tenantId?: number) {
  await ensureMobileAuthSchema()
  if (tenantId == null) throw new Error("Tenant context is required to revoke a mobile session")
  await withTransaction(async (connection) => {
    await connection.query("UPDATE mobile_sessions SET revoked_at=NOW(),revoked_reason=? WHERE session_id=? AND user_id=? AND tenant_id=? AND revoked_at IS NULL", [reason.slice(0, 60), sessionId, userId, tenantId])
    await connection.query("UPDATE mobile_device_registrations SET enabled=0 WHERE mobile_session_id=? AND user_id=? AND tenant_id=?", [sessionId,userId,tenantId])
  })
}
/**
 * Revoke every active mobile session for a user. Used by Super Admin password
 * resets so a credential change immediately invalidates any signed-in device,
 * matching the existing security policy that a password change ends sessions.
 * Returns the number of sessions that were revoked.
 */
export async function revokeAllMobileSessionsForUser(userId: number, reason = "password_reset"): Promise<number> {
  await ensureMobileAuthSchema()
  const result = await query<{ affectedRows: number }>("UPDATE mobile_sessions SET revoked_at=NOW(),revoked_reason=? WHERE user_id=? AND revoked_at IS NULL", [reason.slice(0, 60), userId])
  return Number(result?.affectedRows ?? 0)
}
export async function listMobileSessions(userId: number, tenantId: number) {
  await ensureMobileAuthSchema(); return query<any[]>("SELECT session_id,device_name,platform,created_at,last_active_at,expires_at FROM mobile_sessions WHERE user_id=? AND tenant_id=? AND revoked_at IS NULL AND expires_at>NOW() ORDER BY last_active_at DESC", [userId, tenantId])
}
export async function auditMobileAction(input: { tenantId: number; userId: number; sessionId?: string | null; action: string; method?: string; path?: string }) {
  await ensureMobileAuthSchema()
  await query("INSERT INTO mobile_api_audit (tenant_id,user_id,session_id,action,method,path) VALUES (?,?,?,?,?,?)", [input.tenantId,input.userId,input.sessionId??null,input.action.slice(0,80),input.method?.slice(0,12)||null,input.path?.slice(0,255)||null]).catch(() => {})
}
