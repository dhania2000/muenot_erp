import "server-only"
import { createHash, randomInt } from "node:crypto"
import mysql from "mysql2/promise"
import { query } from "@/lib/db"
import { decryptToken, encryptToken } from "@/lib/token-crypto"
import { GRAPH_VERSION, getWhatsAppIntegrationByIdForTenant, type WhatsAppIntegrationRow } from "@/lib/whatsapp"

export const registrationDDL = [
  "CREATE TABLE IF NOT EXISTS marketing_whatsapp_registration (tenant_id INT UNSIGNED NOT NULL, connection_id INT UNSIGNED NOT NULL, pin_encrypted TEXT NULL, cloud_api_registered BOOLEAN NOT NULL DEFAULT FALSE, registration_status VARCHAR(40) NOT NULL DEFAULT 'pending', registration_error_code VARCHAR(40) NULL, registration_error_message VARCHAR(500) NULL, registration_checked_at DATETIME NULL, PRIMARY KEY (tenant_id,connection_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS marketing_whatsapp_signup_progress (tenant_id INT UNSIGNED NOT NULL, signup_id INT UNSIGNED NOT NULL, exchange_status VARCHAR(32) NOT NULL, token_encrypted TEXT NULL, connection_id INT UNSIGNED NULL, PRIMARY KEY (tenant_id,signup_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
]
let schema: Promise<void> | undefined
export function ensureRegistrationSchema() {
  return schema ??= (async () => { for (const ddl of registrationDDL) await query(ddl) })().catch(e => { schema = undefined; throw e })
}

// Connection-scoped MySQL locks serialize finalization across app processes.
// They release automatically on crash/disconnect; no network call holds a DB transaction.
export async function withWhatsAppLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Dedicated connection: holding a named lock must not exhaust the shared
  // query pool while finalization itself waits for queries from that pool.
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectTimeout: 10000,
  })
  const name = "wa:" + createHash("sha256").update(key).digest("hex").slice(0, 60)
  let acquired = false
  try {
    const [rows] = await connection.query<any[]>("SELECT GET_LOCK(?,0) AS acquired", [name])
    acquired = Number(rows[0]?.acquired) === 1
    if (!acquired) throw new Error("WhatsApp finalization is already running. Refresh status shortly.")
    return await fn()
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK(?)", [name]).catch(() => {})
    await connection.end()
  }
}

export class RegistrationError extends Error {
  constructor(public code: string, public httpStatus = 0, public subcode: number | null = null) {
    super(code === "190" ? "Meta token is invalid or expired. Reauthorize this connection."
      : code === "TIMEOUT" ? "Meta did not respond in time. Retry will check status before sending another registration request."
      : code === "PIN_REQUIRED" ? "Enter this number's existing six-digit two-step verification PIN, or reset it in WhatsApp Manager."
      : code === "ENCRYPTION_REQUIRED" ? "Secure credential storage is unavailable. Configure SETTINGS_ENCRYPTION_KEY."
      : code === "OWNERSHIP" ? "The phone number could not be verified in this connection's WhatsApp Business Account."
      : code === "CREDENTIALS" ? "Stored credentials are missing or cannot be decrypted."
      : code === "BUSINESS_PENDING" ? "Business verification is pending in Meta. Complete it in WhatsApp Manager."
      : "Meta could not finalize registration. Check WhatsApp permissions, number eligibility and two-step verification in WhatsApp Manager.")
    if (/^\d+$/.test(code)) this.message = "Cloud API registration failed (Meta error " + code + "): " + this.message
  }
}

async function graph(row: WhatsAppIntegrationRow, token: string, path: string, operation: string, body?: object) {
  const metadata = { tenant_id: row.tenant_id, connection_id: row.id, waba_id: row.waba_id, phone_number_id: row.phone_number_id, graph_version: GRAPH_VERSION, operation }
  console.info("[whatsapp.registration]", { ...metadata, phase: "start", timestamp: new Date().toISOString() })
  try {
    const response = await fetch("https://graph.facebook.com/" + GRAPH_VERSION + "/" + path, {
      method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(15000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      const code = Number.isSafeInteger(data.error?.code) ? String(data.error.code) : "META_ERROR"
      throw new RegistrationError(code, response.status, Number.isSafeInteger(data.error?.error_subcode) ? data.error.error_subcode : null)
    }
    console.info("[whatsapp.registration]", { ...metadata, phase: "success", http_status: response.status, timestamp: new Date().toISOString() })
    return data
  } catch (error) {
    const safe = error instanceof RegistrationError ? error : new RegistrationError("TIMEOUT")
    console.warn("[whatsapp.registration]", { ...metadata, phase: "failure", http_status: safe.httpStatus, meta_error_code: safe.code, meta_error_subcode: safe.subcode, message: safe.message, timestamp: new Date().toISOString() })
    throw safe
  }
}

export type RegistrationResult = { cloudApiRegistered: boolean; status: string; errorCode: string | null; errorMessage: string | null; checkedAt: string }
async function persist(row: WhatsAppIntegrationRow, status: string, error?: RegistrationError): Promise<RegistrationResult> {
  const registered = status === "registered"
  await query("INSERT INTO marketing_whatsapp_registration (tenant_id,connection_id,cloud_api_registered,registration_status,registration_error_code,registration_error_message,registration_checked_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE cloud_api_registered=VALUES(cloud_api_registered),registration_status=VALUES(registration_status),registration_error_code=VALUES(registration_error_code),registration_error_message=VALUES(registration_error_message),registration_checked_at=VALUES(registration_checked_at)",
    [row.tenant_id, row.id, registered ? 1 : 0, status, error?.code ?? null, error?.message ?? null])
  return { cloudApiRegistered: registered, status, errorCode: error?.code ?? null, errorMessage: error?.message ?? null, checkedAt: new Date().toISOString() }
}

export async function readMetaRegistration(row: WhatsAppIntegrationRow, preserveFailure = false): Promise<RegistrationResult> {
  await ensureRegistrationSchema()
  try {
    const token = decryptToken(row.access_token)
    if (!token) throw new RegistrationError("CREDENTIALS")
    if (!/^\d+$/.test(row.phone_number_id)) throw new RegistrationError("OWNERSHIP")
    // Never drop the status field on error. Missing status is unknown, not unregistered.
    const profile = await graph(row, token, encodeURIComponent(row.phone_number_id) + "?fields=status,platform_type", "verify_registration")
    const status = profile.platform_type === "ON_PREMISE" ? "migration_required"
      : profile.status === "CONNECTED" && profile.platform_type === "CLOUD_API" ? "registered"
      : profile.status === "PENDING" ? "pending"
      : profile.status === "DISCONNECTED" || profile.status === "UNREGISTERED" ? "not_registered"
      : profile.status === "PENDING_BUSINESS_VERIFICATION" ? "business_verification_pending" : "unconfirmed"
    if (preserveFailure && status !== "registered") {
      const [previous] = await query<any[]>("SELECT registration_status,registration_error_code FROM marketing_whatsapp_registration WHERE tenant_id=? AND connection_id=?", [row.tenant_id, row.id])
      if (previous && ["failed", "uncertain"].includes(previous.registration_status)) return persist(row, previous.registration_status, new RegistrationError(previous.registration_error_code || "META_ERROR"))
    }
    return await persist(row, status)
  } catch (error) { return persist(row, "failed", error instanceof RegistrationError ? error : new RegistrationError("META_ERROR")) }
}

async function verifyOwnership(row: WhatsAppIntegrationRow, token: string) {
  const foreign = await query<any[]>("SELECT tenant_id FROM marketing_whatsapp_integration WHERE phone_number_id=? AND released_at IS NULL AND (tenant_id IS NULL OR tenant_id<>?) LIMIT 1", [row.phone_number_id, row.tenant_id])
  if (foreign.length) throw new RegistrationError("OWNERSHIP")
  let after: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await graph(row, token, encodeURIComponent(row.waba_id) + "/phone_numbers?fields=id&limit=100" + (after ? "&after=" + encodeURIComponent(after) : ""), "verify_phone_ownership")
    if (result.data?.some((phone: { id?: string }) => phone.id === row.phone_number_id)) return
    if (!result.paging?.next || !result.paging?.cursors?.after) break
    after = result.paging.cursors.after
  }
  throw new RegistrationError("OWNERSHIP")
}

async function syncPhoneMetadata(row: WhatsAppIntegrationRow, token: string) {
  try {
    const profile = await graph(row, token, encodeURIComponent(row.phone_number_id) + "?fields=display_phone_number,verified_name,quality_rating", "sync_phone_metadata")
    await query("UPDATE marketing_whatsapp_integration SET display_phone_number=?,verified_name=?,quality_rating=? WHERE tenant_id=? AND id=?",
      [profile.display_phone_number ?? null, profile.verified_name ?? null, profile.quality_rating ?? null, row.tenant_id, row.id])
  } catch { /* Registration is still verified; metadata can be refreshed later. */ }
}

/** Tenant/id come from verified request context, not global environment identity. */
export async function finalizeWhatsAppRegistration(tenantId: number, connectionId: number, existingPin?: string): Promise<RegistrationResult> {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !Number.isSafeInteger(connectionId) || connectionId <= 0) throw new Error("Invalid connection")
  if (existingPin !== undefined && !/^\d{6}$/.test(existingPin)) throw new Error("PIN must contain exactly six digits")
  await ensureRegistrationSchema()
  return withWhatsAppLock("connection:" + tenantId + ":" + connectionId, async () => {
    const row = await getWhatsAppIntegrationByIdForTenant(connectionId, tenantId)
    if (!row) throw new Error("WhatsApp connection not found")
    try {
      const token = decryptToken(row.access_token)
      if (!token) throw new RegistrationError("CREDENTIALS")
      if (!/^\d+$/.test(row.phone_number_id) || !/^\d+$/.test(row.waba_id)) throw new RegistrationError("OWNERSHIP")
      await verifyOwnership(row, token)
      const current = await readMetaRegistration(row)
      if (current.cloudApiRegistered) { await syncPhoneMetadata(row, token); return current }
      if (current.status === "failed") return current // do not POST after auth/network/verification errors
      if (current.status === "business_verification_pending") return current
      if (current.status === "migration_required") return current
      if (current.status === "unconfirmed") return current // absence of status is not permission to re-register
      const [saved] = await query<any[]>("SELECT pin_encrypted FROM marketing_whatsapp_registration WHERE tenant_id=? AND connection_id=?", [tenantId, connectionId])
      let pin = existingPin ?? decryptToken(saved?.pin_encrypted)
      if (!pin && saved?.pin_encrypted) throw new RegistrationError("CREDENTIALS")
      if (!pin) pin = String(randomInt(0, 1000000)).padStart(6, "0")
      const encrypted = encryptToken(pin)
      if (!encrypted?.startsWith("enc:v1:")) throw new RegistrationError("ENCRYPTION_REQUIRED")
      await query("UPDATE marketing_whatsapp_registration SET pin_encrypted=?,registration_status='registering' WHERE tenant_id=? AND connection_id=?", [encrypted, tenantId, connectionId])
      const accepted = await graph(row, token, encodeURIComponent(row.phone_number_id) + "/register", "register_phone", { messaging_product: "whatsapp", pin })
      if (accepted.success !== true && accepted.success !== "true") throw new RegistrationError("META_ERROR")
      // A successful POST is only acceptance; readiness requires a fresh Meta status.
      const verified = await readMetaRegistration(row)
      if (verified.cloudApiRegistered) await syncPhoneMetadata(row, token)
      return verified
    } catch (error) {
      return persist(row, error instanceof RegistrationError && error.code === "TIMEOUT" ? "uncertain" : "failed",
        error instanceof RegistrationError ? error : new RegistrationError("META_ERROR"))
    }
  })
}
