import "server-only"
import type { RowDataPacket } from "mysql2"
import { createHash, randomBytes } from "node:crypto"
import { pool, query } from "@/lib/db"
import { getTenantById } from "@/lib/tenant-service"
import { runForTenant } from "@/lib/tenant-scope"
import { createWhatsAppSignupSession, handleWhatsAppSignupCallback } from "@/lib/whatsapp-signup"
import { auditMobileAction, type MobilePrincipal } from "@/lib/mobile-auth"

const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const TTL_MS = 10 * 60_000
type Launch = { id: number; tenant_id: number; user_id: number; mobile_session_id: string; status: "pending" | "started" | "completed" | "failed"; signup_state: string | null; expires_at: string }
type LaunchRecord = Launch & RowDataPacket
export class MobileOnboardingError extends Error { constructor(message: string, public status = 400) { super(message) } }
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
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new MobileOnboardingError("Invalid onboarding session.", 401)
  await ensureMobileOnboardingSchema()
  const [row] = await query<Launch[]>(`SELECT l.* FROM mobile_whatsapp_onboarding l
    JOIN mobile_sessions s ON s.session_id=l.mobile_session_id AND s.user_id=l.user_id AND s.tenant_id=l.tenant_id
    JOIN users u ON u.id=l.user_id AND u.tenant_id=l.tenant_id
    JOIN tenants t ON t.id=l.tenant_id
    WHERE l.token_hash=? AND l.expires_at>NOW() AND s.revoked_at IS NULL AND s.expires_at>NOW()
      AND u.status='active' AND u.role='admin' AND u.tenant_role IN ('tenant_owner','tenant_admin')
      AND t.status='active' AND t.tenant_type='SHOPKEEPER' LIMIT 1`, [hash(token)])
  if (!row) throw new MobileOnboardingError("Onboarding session expired. Return to the app and retry.", 410)
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
  if (row.status !== "started" || !row.signup_state || row.signup_state !== input.state) throw new MobileOnboardingError("Onboarding state is invalid or already used.", 409)
  if (!/^\d+$/.test(input.wabaId) || !/^\d+$/.test(input.phoneNumberId) || !input.code) throw new MobileOnboardingError("Meta did not return valid signup details.", 400)
  const result = await handleWhatsAppSignupCallback({ state: row.signup_state, code: input.code, wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId, businessId: input.businessId, expectedTenantId: row.tenant_id, expectedUserId: row.user_id })
  if (!result.ok) {
    await query("UPDATE mobile_whatsapp_onboarding SET status='failed',completed_at=NOW() WHERE id=? AND status='started'", [row.id])
    await auditMobileAction({ tenantId: row.tenant_id, userId: row.user_id, action: "whatsapp_connection_failed" })
    throw new MobileOnboardingError("WhatsApp connection could not be completed. Check its status in the app and retry if needed.", 422)
  }
  await query("UPDATE mobile_whatsapp_onboarding SET status='completed',completed_at=NOW() WHERE id=? AND status='started'", [row.id])
  await auditMobileAction({ tenantId: row.tenant_id, userId: row.user_id, action: "whatsapp_connected" })
  const messagingReady = result.registration?.cloudApiRegistered === true
  const webhookSubscribed = result.autoConfig?.webhookSubscribed === true
  return { connected: messagingReady && webhookSubscribed, messagingReady, webhookSubscribed }
}
