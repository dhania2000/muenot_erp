import "server-only"
import type { RowDataPacket } from "mysql2"
import { createHash, randomBytes } from "node:crypto"
import { pool, query } from "@/lib/db"
import { getTenantById } from "@/lib/tenant-service"
import { runForTenant } from "@/lib/tenant-scope"
import { createWhatsAppSignupSession, handleWhatsAppSignupCallback } from "@/lib/whatsapp-signup"
import { auditMobileAction, type MobilePrincipal } from "@/lib/mobile-auth"

const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const TTL_MS = 20 * 60_000
type Launch = { id: number; tenant_id: number; user_id: number; mobile_session_id: string; status: "pending" | "started" | "completed" | "failed"; signup_state: string | null; expires_at: string }
type LaunchRecord = Launch & RowDataPacket
export class MobileOnboardingError extends Error {
  constructor(message: string, public status = 400, public code = "ONBOARDING_FAILED") { super(message) }
}
function diagnostic(stage: string, result: string, code?: string, row?: Partial<Launch>) {
  console.info("[mobile.whatsapp.onboarding]", { stage, result, ...(code ? { code } : {}),
    ...(row ? { onboardingId: row.id, tenantId: row.tenant_id, userId: row.user_id } : {}) })
}
let ensured: Promise<void> | undefined
export function ensureMobileOnboardingSchema() {
  return ensured ??= query(`CREATE TABLE IF NOT EXISTS mobile_whatsapp_onboarding (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, token_hash CHAR(64) NOT NULL,
    tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, mobile_session_id VARCHAR(64) NOT NULL,
    signup_state VARCHAR(191) NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL, completed_at DATETIME NULL,
    PRIMARY KEY(id), UNIQUE KEY uq_mobile_wa_launch_token(token_hash), UNIQUE KEY uq_mobile_wa_signup_state(signup_state),
    KEY idx_mobile_wa_launch_owner(tenant_id,user_id,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => undefined).catch(error => { ensured = undefined; throw error })
}
export async function requireApprovedShopkeeper(principal: MobilePrincipal) {
  const tenant = await getTenantById(principal.tenantId)
  if (!tenant || tenant.tenant_type !== "SHOPKEEPER" || tenant.status !== "active") throw new MobileOnboardingError("Shopkeeper account is not active.", 403)
  if (principal.role !== "admin" || !["tenant_owner", "tenant_admin"].includes(principal.tenantRole)) throw new MobileOnboardingError("Only a Shopkeeper owner or admin can connect WhatsApp.", 403)
}
function baseUrl() {
  const raw = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (!raw) throw new MobileOnboardingError("App URL is not configured.", 503)
  const url = new URL(raw)
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new MobileOnboardingError("HTTPS is required for onboarding.", 503)
  return url.origin
}
export async function createMobileOnboarding(principal: MobilePrincipal) {
  await requireApprovedShopkeeper(principal)
  const origin = baseUrl()
  await ensureMobileOnboardingSchema()
  const token = randomBytes(32).toString("base64url")
  const expires = new Date(Date.now() + TTL_MS)
  await query("INSERT INTO mobile_whatsapp_onboarding (token_hash,tenant_id,user_id,mobile_session_id,expires_at) VALUES (?,?,?,?,?)", [hash(token),principal.tenantId,principal.userId,principal.sessionId,expires.toISOString().slice(0,19).replace("T"," ")])
  await auditMobileAction({ tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId, action: "whatsapp_onboarding_started" })
  return { url: `${origin}/mobile/whatsapp/connect#session=${token}`, expiresAt: expires.toISOString() }
}

async function getLaunch(token: string): Promise<Launch> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new MobileOnboardingError("Invalid onboarding session.", 401, "ONBOARDING_SESSION_MISSING")
  await ensureMobileOnboardingSchema()
  const [row] = await query<Launch[]>(`SELECT l.* FROM mobile_whatsapp_onboarding l
    JOIN mobile_sessions s ON s.session_id=l.mobile_session_id AND s.user_id=l.user_id AND s.tenant_id=l.tenant_id
    JOIN users u ON u.id=l.user_id AND u.tenant_id=l.tenant_id
    JOIN tenants t ON t.id=l.tenant_id
    WHERE l.token_hash=? AND (l.status='completed' OR l.expires_at>UTC_TIMESTAMP()) AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP()
      AND u.status='active' AND u.role='admin' AND u.tenant_role IN ('tenant_owner','tenant_admin')
      AND t.status='active' AND t.tenant_type='SHOPKEEPER' LIMIT 1`, [hash(token)])
  if (!row) {
    const [known] = await query<Array<{ expired: number; status: string }>>(
      "SELECT status, (expires_at<=UTC_TIMESTAMP()) AS expired FROM mobile_whatsapp_onboarding WHERE token_hash=? LIMIT 1", [hash(token)])
    const code = !known ? "ONBOARDING_SESSION_MISSING" : Number(known.expired) ? "ONBOARDING_SESSION_EXPIRED" : "TENANT_MAPPING_FAILED"
    diagnostic("session_lookup", "failed", code)
    throw new MobileOnboardingError("Onboarding session expired or unavailable. Return to the app and retry.", 410, code)
  }
  return row
}

export async function launchMobileSignup(token: string) {
  const row = await getLaunch(token)
  if (row.status !== "pending") throw new MobileOnboardingError("Onboarding session was already used.", 409)
  // A row lock prevents two browser tabs from redeeming the same mobile launch.
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [locked] = await conn.query<LaunchRecord[]>("SELECT * FROM mobile_whatsapp_onboarding WHERE id=? FOR UPDATE", [row.id])
    if (locked[0]?.status !== "pending") throw new MobileOnboardingError("Onboarding session was already used.", 409)
    const signup = await runForTenant({ tenantId: row.tenant_id }, () => createWhatsAppSignupSession(row.user_id))
    await conn.query("UPDATE mobile_whatsapp_onboarding SET signup_state=?,status='started' WHERE id=? AND status='pending'", [signup.state,row.id])
    await conn.commit()
    return signup
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
}

export async function finishMobileSignup(input: { launchToken: string; state: string; code: string; wabaId: string; phoneNumberId: string; businessId?: string }) {
  const row = await getLaunch(input.launchToken)
  diagnostic("completion", "started", undefined, row)
  if (!row.signup_state || row.signup_state !== input.state) {
    diagnostic("state_validation", "failed", "STATE_SESSION_MISMATCH", row)
    throw new MobileOnboardingError("Onboarding state does not match this session.", 409, "STATE_SESSION_MISMATCH")
  }
  if (row.status !== "started" && row.status !== "completed") {
    diagnostic("session_validation", "failed", "ONBOARDING_SESSION_ALREADY_CONSUMED", row)
    throw new MobileOnboardingError("Onboarding session was already used.", 409, "ONBOARDING_SESSION_ALREADY_CONSUMED")
  }
  if (row.status !== "completed" && !input.code.trim()) {
    diagnostic("authorization_code", "failed", "AUTH_CODE_MISSING", row)
    throw new MobileOnboardingError("Meta did not return an authorization code.", 400, "AUTH_CODE_MISSING")
  }
  if ([input.wabaId, input.phoneNumberId, input.businessId].some(id => id && !/^\d+$/.test(id)))
    throw new MobileOnboardingError("Meta returned invalid signup identifiers.", 400, "SESSION_INFO_INVALID")
  const result = await handleWhatsAppSignupCallback({ state: row.signup_state, code: input.code, wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId, businessId: input.businessId, expectedTenantId: row.tenant_id, expectedUserId: row.user_id })
  if (!result.ok) {
    diagnostic("shared_finalization", "failed", result.failureCode ?? "CONNECTION_FAILED", row)
    await auditMobileAction({ tenantId: row.tenant_id, userId: row.user_id, action: "whatsapp_connection_failed" })
    throw new MobileOnboardingError(result.failureCode === "WHATSAPP_PHONE_ALREADY_ASSIGNED"
      ? "This WhatsApp number is already connected to another Muenot account. Disconnect it from the previous account or contact Muenot support."
      : "WhatsApp connection could not be completed. Check its status in the app and retry if needed.", 422, result.failureCode ?? "CONNECTION_FAILED")
  }
  if (!result.integration) throw new MobileOnboardingError("Connection was not persisted. Retry status shortly.", 503, "CONNECTION_PERSISTENCE_FAILED")
  if (row.status !== "completed") {
    try { await query("UPDATE mobile_whatsapp_onboarding SET status='completed',completed_at=UTC_TIMESTAMP() WHERE id=? AND status='started'", [row.id]) }
    catch { diagnostic("onboarding_session_persistence", "failed", "DATABASE_TRANSACTION_FAILED", row); throw new MobileOnboardingError("Connection saved, but onboarding status could not be updated. Retry completion.", 503, "DATABASE_TRANSACTION_FAILED") }
  }
  await auditMobileAction({ tenantId: row.tenant_id, userId: row.user_id, action: "whatsapp_connected" })
  const messagingReady = result.registration?.cloudApiRegistered === true
  const webhookSubscribed = result.autoConfig?.webhookSubscribed === true
  diagnostic("completion", "completed", undefined, row)
  return { connected: true, messagingReady, webhookSubscribed }
}
