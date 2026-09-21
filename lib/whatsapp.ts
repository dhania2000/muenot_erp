import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"
import { query } from "@/lib/db"
import { encryptToken, decryptToken } from "@/lib/token-crypto"
import { currentTenantId, currentTenantIdOrNull } from "@/lib/tenant-scope"

/**
 * WhatsApp Business Cloud API integration.
 *
 * Unlike the other social channels (which use OAuth), WhatsApp Business is
 * connected by supplying credentials from the Meta app dashboard:
 *   - WhatsApp Business Account (WABA) ID
 *   - Phone Number ID (the dedicated business number registered on the WABA)
 *   - A permanent System User access token
 *
 * The access token is encrypted at rest with the app's existing AES-256-GCM
 * scheme (lib/token-crypto, keyed by SETTINGS_ENCRYPTION_KEY) and decrypted
 * only when a Graph API call actually needs it.
 */

/**
 * Graph API version is centralized here and overridable via env so we never
 * have to touch code when Meta deprecates a version. Keep the default on a
 * currently-supported version.
 */
export const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION?.trim() || "v26.0"
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

/** Structured Graph API error, surfaced to callers without leaking secrets. */
export type GraphError = {
  code?: number
  subcode?: number
  type?: string
  message: string
}

/**
 * Parses a Graph API error body into a useful, human-readable message. Adds
 * actionable guidance for the errors administrators actually hit, without ever
 * echoing tokens, secrets or PINs.
 */
export function parseGraphError(
  error: { message?: string; type?: string; code?: number; error_subcode?: number } | undefined,
  status: number,
): GraphError {
  const code = error?.code
  const base = error?.message || `Graph API returned ${status}`
  let message = base

  if (code === 133010) {
    message = `${base}. Cloud API registration is incomplete. Open WhatsApp Settings and use Retry registration with the existing connection.`
  } else if (code === 190) {
    message = `${base}. The access token is invalid or expired — an administrator needs to generate a new permanent System User token.`
  } else if (code === 10 || code === 200 || code === 3) {
    message = `${base}. The System User token is missing a required WhatsApp permission (whatsapp_business_messaging / whatsapp_business_management).`
  } else if (code === 131030) {
    message = `${base}. The recipient's number is not in the allowed list for this (test) number.`
  }

  return { code, subcode: error?.error_subcode, type: error?.type, message }
}

let tableEnsured = false

/**
 * Adds a column only if it does not already exist. MySQL has no portable
 * `ADD COLUMN IF NOT EXISTS`, so we probe information_schema first. Used to
 * evolve the integration table without a manual migration.
 */
async function ensureColumn(table: string, column: string, ddl: string) {
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )
  if (!rows[0]?.c) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`)
  }
}

export async function ensureWhatsAppTable() {
  if (tableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_integration\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`waba_id\` VARCHAR(191) NOT NULL,
      \`phone_number_id\` VARCHAR(191) NOT NULL,
      \`display_phone_number\` VARCHAR(64) DEFAULT NULL,
      \`verified_name\` VARCHAR(191) DEFAULT NULL,
      \`business_name\` VARCHAR(191) DEFAULT NULL,
      \`business_id\` VARCHAR(191) DEFAULT NULL,
      \`quality_rating\` VARCHAR(32) DEFAULT NULL,
      \`platform_type\` VARCHAR(32) DEFAULT NULL,
      \`access_token\` TEXT NOT NULL,
      \`connected_by_user_id\` INT UNSIGNED DEFAULT NULL,
      \`connected_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_integration_tenant_phone\` (\`tenant_id\`, \`phone_number_id\`),
      KEY \`idx_marketing_whatsapp_integration_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Older deployments predate the platform_type column — add it idempotently.
  await ensureColumn(
    "marketing_whatsapp_integration",
    "platform_type",
    "`platform_type` VARCHAR(32) DEFAULT NULL",
  )
  // Multi-tenant isolation: every integration belongs to exactly one tenant.
  // Mirrors database/migrations/2026-11-19-whatsapp-multi-tenant-isolation.sql
  // so a deployment that has not imported that SQL still isolates correctly.
  await ensureColumn(
    "marketing_whatsapp_integration",
    "tenant_id",
    "`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`",
  )
  // Older deployments predate the Meta business id column — add it idempotently.
  await ensureColumn(
    "marketing_whatsapp_integration",
    "business_id",
    "`business_id` VARCHAR(191) DEFAULT NULL",
  )
  await ensureTenantScopedUniquePhone()
  tableEnsured = true
}

/**
 * Replaces the legacy global `UNIQUE(phone_number_id)` with a tenant-scoped
 * `UNIQUE(tenant_id, phone_number_id)` so two tenants may legitimately connect
 * the same number. Idempotent and non-fatal (the app-layer scoping still
 * isolates even if the DDL cannot run on a legacy engine).
 */
async function ensureTenantScopedUniquePhone() {
  try {
    const composite = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_whatsapp_integration'
          AND INDEX_NAME = 'uniq_wa_integration_tenant_phone'`,
    )
    if (composite[0]?.c) return
    await query("ALTER TABLE `marketing_whatsapp_integration` DROP INDEX `uniq_phone_number`").catch(() => {})
    await query(
      "ALTER TABLE `marketing_whatsapp_integration` ADD UNIQUE KEY `uniq_wa_integration_tenant_phone` (`tenant_id`, `phone_number_id`)",
    ).catch(() => {})
  } catch {
    /* non-fatal: app-layer tenant scoping still isolates */
  }
}

export type WhatsAppIntegrationRow = {
  id: number
  tenant_id: number | null
  waba_id: string
  phone_number_id: string
  display_phone_number: string | null
  verified_name: string | null
  business_name: string | null
  business_id: string | null
  quality_rating: string | null
  platform_type: string | null
  access_token: string
  connected_by_user_id: number | null
  connected_at: string
  updated_at: string
}

/** Public shape returned to the client — never exposes the access token. */
export type WhatsAppIntegrationPublic = {
  id: number
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string | null
  verifiedName: string | null
  businessName: string | null
  businessId: string | null
  qualityRating: string | null
  platformType: string | null
  connectedAt: string
  updatedAt: string
  /**
   * Whether the encrypted access token is present and decryptable at rest.
   * This is a cheap, offline signal ("do we hold a usable secret?") and is NOT
   * a live Meta validity probe — that lives in the per-integration health test.
   * The token value itself is NEVER included in any public shape.
   */
  tokenStatus: "stored" | "missing"
}

export function toPublicIntegration(row: WhatsAppIntegrationRow): WhatsAppIntegrationPublic {
  return {
    id: row.id,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    businessName: row.business_name,
    businessId: row.business_id,
    qualityRating: row.quality_rating,
    platformType: row.platform_type,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    tokenStatus: decryptToken(row.access_token) ? "stored" : "missing",
  }
}

/**
 * Builds an integration row from the server environment when an administrator
 * has provisioned the number via env vars instead of the UI.
 *
 * This is the admin-only backend configuration path. The access token is read
 * from the env only on the server and is treated as plaintext by decryptToken
 * (it has no `enc:v1:` marker), so no key is needed. Returns null unless the
 * three core identifiers are all present.
 *
 * IMPORTANT: we deliberately leave `platform_type` as `null` here. The mere
 * presence of env vars proves nothing about the number's live Cloud API state;
 * `platform_type` is only ever asserted from a LIVE Meta probe
 * (verifyWhatsAppCredentials) or from data validated during Embedded Signup and
 * persisted to the DB. This prevents the UI from showing a false state (see the
 * #133010 "Account not registered" case, where env vars exist but Cloud API
 * messaging is not registered).
 */
export function getEnvIntegration(): WhatsAppIntegrationRow | null {
  const wabaId = process.env.WHATSAPP_WABA_ID?.trim()
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim()
  if (!wabaId || !phoneNumberId || !accessToken) return null

  const now = new Date().toISOString().slice(0, 19).replace("T", " ")
  const businessName = process.env.WHATSAPP_BUSINESS_NAME?.trim() || null
  return {
    // id 0 marks an env-provisioned integration — it lives in no DB row, so the
    // UI's "Disconnect" (DELETE by id) is a harmless no-op against it.
    id: 0,
    // The env number is a legacy single-number provision; it is attributed to
    // whichever tenant is currently in context (or unknown before auth).
    tenant_id: currentTenantIdOrNull(),
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    display_phone_number: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER?.trim() || null,
    verified_name: businessName,
    business_name: businessName,
    business_id: process.env.WHATSAPP_BUSINESS_ID?.trim() || null,
    quality_rating: null,
    // Unknown until Meta confirms it live.
    platform_type: null,
    access_token: accessToken,
    connected_by_user_id: null,
    connected_at: now,
    updated_at: now,
  }
}

/**
 * Returns the active WhatsApp integration FOR THE CURRENT TENANT. Derives the
 * tenant from the verified session context (never from client input): a row
 * saved through the UI takes precedence, otherwise it falls back to the
 * env-provisioned number. When there is no tenant in context (system/boot) it
 * returns only the env number so nothing leaks a tenant's saved credentials.
 *
 * Existing session-scoped callers keep calling this unchanged and are now
 * automatically isolated. Background jobs must establish a tenant first with
 * runForTenant() (or call getWhatsAppIntegrationForTenant explicitly).
 */
export async function getWhatsAppIntegration(): Promise<WhatsAppIntegrationRow | null> {
  const tenantId = currentTenantIdOrNull()
  // Never let a request with no authenticated tenant fall through to global
  // environment credentials. Platform-only callers that intentionally need
  // those credentials must call getEnvIntegration() directly.
  if (tenantId == null) return null
  return getWhatsAppIntegrationForTenant(tenantId)
}

/**
 * The active integration for an explicit tenant id.
 *
 * Returns ONLY the tenant's own connected row. We deliberately do NOT fall back
 * to the env-provisioned number here: that fallback is a single, global,
 * legacy number and surfacing it per-tenant both breaks isolation and makes
 * "Disconnect" appear to do nothing (deleting the row would just re-reveal the
 * env number as connected). The env number is still available for the
 * no-session/system path (getWhatsAppIntegration) and the webhook phone-number
 * lookup (getWhatsAppIntegrationByPhoneNumberId). A tenant that wants to use the
 * env credentials connects them once via the UI, which persists a real,
 * disconnectable row.
 */
export async function getWhatsAppIntegrationForTenant(
  tenantId: number,
): Promise<WhatsAppIntegrationRow | null> {
  await ensureWhatsAppTable()
  const rows = await query<WhatsAppIntegrationRow[]>(
    "SELECT * FROM `marketing_whatsapp_integration` WHERE tenant_id = ? ORDER BY connected_at DESC LIMIT 1",
    [tenantId],
  )
  return rows[0] ?? null
}

/** Every integration connected by the current tenant (for multi-number UIs). */
export async function listWhatsAppIntegrationsForTenant(): Promise<WhatsAppIntegrationRow[]> {
  await ensureWhatsAppTable()
  const rows = await query<WhatsAppIntegrationRow[]>(
    "SELECT * FROM `marketing_whatsapp_integration` WHERE tenant_id = ? ORDER BY connected_at DESC",
    [currentTenantId()],
  )
  return rows
}

export type WhatsAppTenantConnection = {
  tenantId: number
  tenantName: string
  tenantSlug: string
  tenantStatus: string
  integration: WhatsAppIntegrationPublic | null
}

/** Platform-only directory of the latest WhatsApp connection per tenant. */
export async function listWhatsAppTenantConnections(): Promise<WhatsAppTenantConnection[]> {
  await ensureWhatsAppTable()
  const rows = await query<
    {
      tenant_id: number
      tenant_name: string
      tenant_slug: string
      tenant_status: string
      integration_id: number | null
      waba_id: string | null
      phone_number_id: string | null
      display_phone_number: string | null
      verified_name: string | null
      business_name: string | null
      business_id: string | null
      quality_rating: string | null
      platform_type: string | null
      access_token: string | null
      connected_by_user_id: number | null
      connected_at: string | null
      updated_at: string | null
    }[]
  >(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status,
            i.id AS integration_id, i.waba_id, i.phone_number_id, i.display_phone_number,
            i.verified_name, i.business_name, i.business_id, i.quality_rating, i.platform_type,
            i.access_token, i.connected_by_user_id, i.connected_at, i.updated_at
       FROM \`tenants\` t
       LEFT JOIN \`marketing_whatsapp_integration\` i
         ON i.id = (
           SELECT i2.id
             FROM \`marketing_whatsapp_integration\` i2
            WHERE i2.tenant_id = t.id
            ORDER BY i2.connected_at DESC, i2.id DESC
            LIMIT 1
         )
      ORDER BY t.is_platform_owner DESC, t.name ASC`,
  )

  return rows.map((row) => {
    const integration = row.integration_id != null
      ? toPublicIntegration({
          id: Number(row.integration_id),
          tenant_id: Number(row.tenant_id),
          waba_id: row.waba_id ?? "",
          phone_number_id: row.phone_number_id ?? "",
          display_phone_number: row.display_phone_number,
          verified_name: row.verified_name,
          business_name: row.business_name,
          business_id: row.business_id,
          quality_rating: row.quality_rating,
          platform_type: row.platform_type,
          access_token: row.access_token ?? "",
          connected_by_user_id: row.connected_by_user_id,
          connected_at: row.connected_at ?? "",
          updated_at: row.updated_at ?? "",
        })
      : null

    return {
      tenantId: Number(row.tenant_id),
      tenantName: row.tenant_name,
      tenantSlug: row.tenant_slug,
      tenantStatus: row.tenant_status,
      integration,
    }
  })
}

/** A specific integration by id, scoped to the current tenant (IDOR-safe). */
export async function getWhatsAppIntegrationByIdForTenant(
  id: number,
  tenantId = currentTenantId(),
): Promise<WhatsAppIntegrationRow | null> {
  await ensureWhatsAppTable()
  const rows = await query<WhatsAppIntegrationRow[]>(
    "SELECT * FROM `marketing_whatsapp_integration` WHERE id = ? AND tenant_id = ? LIMIT 1",
    [id, tenantId],
  )
  return rows[0] ?? null
}

/**
 * Resolves the exact integration a tenant-owned record (campaign, automation,
 * conversation, media, …) must use for a Meta API call.
 *
 * Rules (see PHASE 11/12/15 of the WhatsApp multi-tenant hardening):
 *   - When the record carries an explicit `integration_id`, that integration
 *     MUST belong to the current tenant. It is looked up tenant-scoped, so a
 *     forged/foreign id resolves to null and we FAIL SAFE (never fall back to
 *     another/default integration for an explicitly-configured record).
 *   - When the record has no integration_id (legacy rows created before
 *     multi-integration support), fall back to the tenant's active integration.
 *
 * Must be called inside a tenant context (session request or a background job
 * already inside runForTenant); it never crosses tenants.
 */
export async function resolveTenantIntegration(
  integrationId: number | null | undefined,
): Promise<WhatsAppIntegrationRow | null> {
  if (integrationId != null && integrationId > 0) {
    // Explicit selection: only ever this tenant's integration, or nothing.
    return getWhatsAppIntegrationByIdForTenant(integrationId)
  }
  // Legacy record without an explicit integration: the tenant's active number.
  return getWhatsAppIntegration()
}

/**
 * Resolves an integration by its Meta phone_number_id WITHOUT a tenant filter.
 * This is the ONLY tenant-agnostic lookup and exists purely so the inbound
 * webhook — which has no session — can discover WHICH tenant a delivery belongs
 * to before entering that tenant's context via runForTenant(). The returned
 * row carries `tenant_id`, which the webhook uses to scope everything after.
 */
export async function getWhatsAppIntegrationByPhoneNumberId(
  phoneNumberId: string,
): Promise<WhatsAppIntegrationRow | null> {
  await ensureWhatsAppTable()
  const rows = await query<WhatsAppIntegrationRow[]>(
    "SELECT * FROM `marketing_whatsapp_integration` WHERE phone_number_id = ? ORDER BY connected_at DESC LIMIT 2",
    [phoneNumberId],
  )
  if (rows.length === 1) return rows[0]
  return null
}

export type PhoneNumberProfile = {
  displayPhoneNumber: string | null
  verifiedName: string | null
  qualityRating: string | null
  /** CLOUD_API | ON_PREMISE | NOT_APPLICABLE (when Meta reports it). */
  platformType: string | null
  /**
   * The phone number node's registration status on the Cloud API
   * (e.g. CONNECTED | PENDING | MIGRATED | BANNED). CONNECTED is the signal
   * that Cloud API messaging is actually registered/usable — the antidote to a
   * silent (#133010) "Account not registered" failure at send time.
   */
  status: string | null
}

type RawPhoneProfile = {
  display_phone_number?: string
  verified_name?: string
  quality_rating?: string
  platform_type?: string
  status?: string
  error?: { message?: string; type?: string; code?: number; error_subcode?: number }
}

/** Requests the phone-number node for a specific field set, throwing on error. */
async function requestPhoneProfile(
  phoneNumberId: string,
  accessToken: string,
  fields: string,
): Promise<RawPhoneProfile> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}?fields=${fields}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new Error(`Could not reach the WhatsApp API: ${(err as Error).message}`)
  }
  const data = (await res.json().catch(() => ({}))) as RawPhoneProfile
  if (!res.ok || data.error) {
    throw Object.assign(new Error(data.error?.message || `Graph API returned ${res.status}`), {
      unsupportedField: data.error?.code === 100 && /nonexisting field|unknown field/i.test(data.error?.message || ""),
    })
  }
  return data
}

/**
 * Validates the credentials by asking the Graph API for the phone number's
 * profile, including `platform_type` and the Cloud API registration `status`.
 * Some numbers / API versions do not expose those extra fields, so we
 * transparently retry with the base field set rather than failing the connect
 * flow. Throws a human-friendly message when Meta rejects the credentials
 * outright.
 */
export async function verifyWhatsAppCredentials(input: {
  phoneNumberId: string
  accessToken: string
}): Promise<PhoneNumberProfile> {
  let data: RawPhoneProfile
  try {
    data = await requestPhoneProfile(
      input.phoneNumberId,
      input.accessToken,
      "display_phone_number,verified_name,quality_rating,platform_type,status",
    )
  } catch (error) {
    if (!(error && typeof error === "object" && "unsupportedField" in error && error.unsupportedField)) throw error
    // Retry with the base fields (covers numbers/versions without the extra
    // platform_type/status fields and re-surfaces a genuine auth error from the
    // second attempt).
    data = await requestPhoneProfile(
      input.phoneNumberId,
      input.accessToken,
      "display_phone_number,verified_name,quality_rating",
    )
  }

  return {
    displayPhoneNumber: data.display_phone_number ?? null,
    verifiedName: data.verified_name ?? null,
    qualityRating: data.quality_rating ?? null,
    platformType: data.platform_type ?? null,
    status: data.status ?? null,
  }
}

export type ConnectWhatsApp = {
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string | null
  verifiedName: string | null
  businessName: string | null
  businessId?: string | null
  qualityRating: string | null
  platformType: string | null
  accessToken: string
  connectedByUserId: number | null
}

export async function upsertWhatsAppIntegration(data: ConnectWhatsApp) {
  const { withWhatsAppLock } = await import("@/lib/whatsapp-registration")
  return withWhatsAppLock("phone:" + data.phoneNumberId, async () => {
    await ensureWhatsAppTable()
    const foreign = await query<{ tenant_id: number }[]>(
      "SELECT tenant_id FROM marketing_whatsapp_integration WHERE phone_number_id=? AND tenant_id<>? LIMIT 1",
      [data.phoneNumberId, currentTenantId()],
    )
    if (foreign.length) throw new Error("This phone number is already assigned to another workspace.")
    return saveWhatsAppIntegration(data)
  })
}

async function saveWhatsAppIntegration(data: ConnectWhatsApp) {
  await ensureWhatsAppTable()
  // Tenant is derived from the verified session context, never from the caller,
  // and stamped so the row belongs to exactly one tenant. The tenant-scoped
  // unique key (tenant_id, phone_number_id) makes the upsert per-tenant.
  const tenantId = currentTenantId()
  await query(
    `INSERT INTO \`marketing_whatsapp_integration\`
      (tenant_id, waba_id, phone_number_id, display_phone_number, verified_name, business_name,
       business_id, quality_rating, platform_type, access_token, connected_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       waba_id = VALUES(waba_id),
       display_phone_number = VALUES(display_phone_number),
       verified_name = VALUES(verified_name),
       business_name = VALUES(business_name),
       business_id = VALUES(business_id),
       quality_rating = VALUES(quality_rating),
       platform_type = VALUES(platform_type),
       access_token = VALUES(access_token),
       connected_by_user_id = VALUES(connected_by_user_id)`,
    [
      tenantId,
      data.wabaId,
      data.phoneNumberId,
      data.displayPhoneNumber,
      data.verifiedName,
      data.businessName,
      data.businessId ?? null,
      data.qualityRating,
      data.platformType,
      encryptToken(data.accessToken),
      data.connectedByUserId,
    ],
  )
}

export async function deleteWhatsAppIntegration(id: number) {
  await ensureWhatsAppTable()
  // Scope the delete to the acting tenant so a forged id can never disconnect
  // another tenant's number.
  await query("DELETE FROM `marketing_whatsapp_integration` WHERE id = ? AND tenant_id = ?", [
    id,
    currentTenantId(),
  ])
}

/* ------------------------------------------------------------------ */
/* Embedded Signup (standard Cloud API onboarding)                     */
/* ------------------------------------------------------------------ */

/**
 * The public Meta App ID used to launch Embedded Signup on the client. We
 * accept a dedicated WhatsApp app id first, then fall back to a shared Meta /
 * Facebook app id when the same app powers both features. The client reads the
 * NEXT_PUBLIC_ variants directly; this helper is for server-side exchange.
 */
export function getAppId(): string | null {
  return (
    process.env.WHATSAPP_APP_ID?.trim() ||
    process.env.NEXT_PUBLIC_WHATSAPP_APP_ID?.trim() ||
    process.env.META_APP_ID?.trim() ||
    process.env.FACEBOOK_APP_ID?.trim() ||
    null
  )
}

/**
 * Exchanges the short-lived authorization `code` returned by Meta's Embedded
 * Signup popup for a business access token, using the app id + app secret. The
 * WABA and phone number are created/selected inside Meta's popup. Server-side
 * finalization must separately register and verify the phone. The returned token is what we
 * store (encrypted) and use for all subsequent Graph API calls.
 */
export async function exchangeEmbeddedSignupCode(
  code: string,
): Promise<{ ok: boolean; accessToken?: string; error?: string }> {
  const appId = getAppId()
  const appSecret = getAppSecret()
  if (!appId || !appSecret) {
    return {
      ok: false,
      error:
        "The server is missing the Meta app id/secret needed to finish WhatsApp onboarding. Set WHATSAPP_APP_ID and WHATSAPP_APP_SECRET (or the shared META_/FACEBOOK_ equivalents).",
    }
  }

  const url =
    `${GRAPH_BASE}/oauth/access_token?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`
  try {
    const res = await fetch(url, { cache: "no-store" })
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      error?: { message?: string; type?: string; code?: number; error_subcode?: number }
    }
    if (!res.ok || data.error || !data.access_token) {
      return { ok: false, error: parseGraphError(data.error, res.status).message }
    }
    return { ok: true, accessToken: data.access_token }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Best-effort lookup of the WABA's business name so the connected view has a
 * friendly label. Never throws — a failure just leaves the name unset.
 */
export async function getWabaName(input: {
  wabaId: string
  accessToken: string
}): Promise<string | null> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(input.wabaId)}?fields=name`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as { name?: string }
    return data.name ?? null
  } catch {
    return null
  }
}

export type SendResult = {
  ok: boolean
  messageId?: string
  error?: string
  errorCode?: number
}

/**
 * Downloads inbound media by its Meta media id. Graph media happens in two
 * hops: first resolve the id to a short-lived signed URL, then fetch the bytes
 * with the same bearer token. Returns the raw buffer plus content type so a
 * route can stream it back to an authenticated agent.
 */
export async function fetchMediaBinary(
  integration: WhatsAppIntegrationRow,
  mediaId: string,
): Promise<{ ok: true; data: ArrayBuffer; contentType: string } | { ok: false; error: string }> {
  const token = decryptToken(integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  try {
    const metaRes = await fetch(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    const meta = (await metaRes.json().catch(() => ({}))) as { url?: string; mime_type?: string; error?: unknown }
    if (!metaRes.ok || !meta.url) return { ok: false, error: "Media not found or expired." }

    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    if (!binRes.ok) return { ok: false, error: "Failed to download media bytes." }
    const data = await binRes.arrayBuffer()
    return {
      ok: true,
      data,
      contentType: meta.mime_type || binRes.headers.get("content-type") || "application/octet-stream",
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Sends a free-form text message via the Cloud API. Note WhatsApp only allows
 * free-form text inside a 24-hour customer service window; outside of it Meta
 * requires an approved template (see sendWhatsAppTemplate).
 */
export async function sendWhatsAppText(input: {
  integration: WhatsAppIntegrationRow
  to: string
  body: string
}): Promise<SendResult> {
  const token = decryptToken(input.integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.integration.phone_number_id)}/messages`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.to,
        type: "text",
        text: { preview_url: false, body: input.body },
      }),
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[]
      error?: { message?: string; type?: string; code?: number; error_subcode?: number }
    }
    if (!res.ok || data.error) {
      const err = parseGraphError(data.error, res.status)
      return { ok: false, error: err.message, errorCode: err.code }
    }
    return { ok: true, messageId: data.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Sends a pre-approved template message. This is the path that works outside
 * the 24-hour window (e.g. broadcasts). Defaults to the mandatory built-in
 * `hello_world` template so the "send test" flow works on a fresh number.
 */
export async function sendWhatsAppTemplate(input: {
  integration: WhatsAppIntegrationRow
  to: string
  templateName: string
  languageCode?: string
}): Promise<SendResult> {
  const token = decryptToken(input.integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.integration.phone_number_id)}/messages`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.to,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: input.languageCode || "en_US" },
        },
      }),
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[]
      error?: { message?: string; type?: string; code?: number; error_subcode?: number }
    }
    if (!res.ok || data.error) {
      const err = parseGraphError(data.error, res.status)
      return { ok: false, error: err.message, errorCode: err.code }
    }
    return { ok: true, messageId: data.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Sends an approved template with positional body variables and an optional
 * media header. This is the campaign/broadcast path — it builds the Cloud API
 * `components` array from the supplied values. `bodyParams` map to {{1}},
 * {{2}}, … in order; `headerMedia` fills an IMAGE/DOCUMENT/VIDEO header.
 */
export async function sendWhatsAppTemplateWithComponents(input: {
  integration: WhatsAppIntegrationRow
  to: string
  templateName: string
  languageCode?: string
  bodyParams?: string[]
  headerMedia?: { kind: "image" | "document" | "video"; link?: string; id?: string } | null
  headerText?: string[] | null
}): Promise<SendResult> {
  const token = decryptToken(input.integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  const components: Record<string, unknown>[] = []

  if (input.headerMedia && (input.headerMedia.link || input.headerMedia.id)) {
    const media: Record<string, unknown> = {}
    if (input.headerMedia.id) media.id = input.headerMedia.id
    if (input.headerMedia.link) media.link = input.headerMedia.link
    components.push({
      type: "header",
      parameters: [{ type: input.headerMedia.kind, [input.headerMedia.kind]: media }],
    })
  } else if (input.headerText && input.headerText.length) {
    components.push({
      type: "header",
      parameters: input.headerText.map((t) => ({ type: "text", text: t })),
    })
  }

  if (input.bodyParams && input.bodyParams.length) {
    components.push({
      type: "body",
      parameters: input.bodyParams.map((t) => ({ type: "text", text: t })),
    })
  }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.integration.phone_number_id)}/messages`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.to,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: input.languageCode || "en_US" },
          ...(components.length ? { components } : {}),
        },
      }),
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[]
      error?: { message?: string; type?: string; code?: number; error_subcode?: number }
    }
    if (!res.ok || data.error) {
      const err = parseGraphError(data.error, res.status)
      return { ok: false, error: err.message, errorCode: err.code }
    }
    return { ok: true, messageId: data.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/* ------------------------------------------------------------------ */
/* Media, mark-as-read and template helpers                            */
/* ------------------------------------------------------------------ */

export type MediaKind = "image" | "document" | "video" | "audio"

/**
 * Sends a media message by Meta media id (already uploaded to Meta) or by a
 * public link. Structured so image/document/video/audio all share one path.
 */
export async function sendWhatsAppMedia(input: {
  integration: WhatsAppIntegrationRow
  to: string
  kind: MediaKind
  mediaId?: string
  link?: string
  caption?: string
  filename?: string
}): Promise<SendResult> {
  const token = decryptToken(input.integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }
  if (!input.mediaId && !input.link) {
    return { ok: false, error: "A media id or a public link is required." }
  }

  const media: Record<string, unknown> = {}
  if (input.mediaId) media.id = input.mediaId
  if (input.link) media.link = input.link
  if (input.caption && input.kind !== "audio") media.caption = input.caption
  if (input.filename && input.kind === "document") media.filename = input.filename

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.integration.phone_number_id)}/messages`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.to,
        type: input.kind,
        [input.kind]: media,
      }),
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[]
      error?: { message?: string; type?: string; code?: number; error_subcode?: number }
    }
    if (!res.ok || data.error) {
      const err = parseGraphError(data.error, res.status)
      return { ok: false, error: err.message, errorCode: err.code }
    }
    return { ok: true, messageId: data.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Marks an inbound message as read (the blue ticks on the customer's side).
 * Best-effort: a failure here should never block opening a conversation.
 */
export async function markWhatsAppMessageRead(input: {
  integration: WhatsAppIntegrationRow
  wamid: string
}): Promise<{ ok: boolean; error?: string }> {
  const token = decryptToken(input.integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.integration.phone_number_id)}/messages`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: input.wamid,
      }),
      cache: "no-store",
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number }
      }
      return { ok: false, error: parseGraphError(data.error, res.status).message }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export type WhatsAppTemplate = {
  name: string
  language: string
  status: string
  category: string | null
}

/**
 * Fetches message templates from the configured WABA so the UI can offer a
 * real selector instead of hardcoding `hello_world`.
 */
export async function getWhatsAppTemplates(
  integration: WhatsAppIntegrationRow,
): Promise<{ ok: boolean; templates: WhatsAppTemplate[]; error?: string }> {
  const token = decryptToken(integration.access_token)
  if (!token) return { ok: false, templates: [], error: "Stored access token could not be read." }

  const url = `${GRAPH_BASE}/${encodeURIComponent(
    integration.waba_id,
  )}/message_templates?fields=name,language,status,category&limit=200`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: { name: string; language: string; status: string; category?: string }[]
      error?: { message?: string; code?: number }
    }
    if (!res.ok || data.error) {
      return { ok: false, templates: [], error: parseGraphError(data.error, res.status).message }
    }
    const templates = (data.data ?? []).map((t) => ({
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category ?? null,
    }))
    return { ok: true, templates }
  } catch (err) {
    return { ok: false, templates: [], error: (err as Error).message }
  }
}

/** A raw template component as returned by the Graph API. */
export type TemplateComponent = {
  type?: string
  format?: string
  text?: string
  buttons?: { type?: string; text?: string; url?: string; phone_number?: string }[]
  example?: unknown
}

/** A fully-detailed template as returned by the Graph API (with components). */
export type DetailedWhatsAppTemplate = {
  metaId: string | null
  name: string
  language: string
  status: string
  category: string | null
  qualityScore: string | null
  rejectedReason: string | null
  components: TemplateComponent[]
}

/**
 * Fetches message templates from the WABA with FULL detail (components, quality
 * score and rejection reason) so the ERP can persist a local catalog and show
 * body previews, rejection reasons and variable counts — not just names.
 * Paginates through all pages so large catalogs sync completely.
 */
export async function fetchWhatsAppTemplatesDetailed(
  integration: WhatsAppIntegrationRow,
): Promise<{ ok: boolean; templates: DetailedWhatsAppTemplate[]; error?: string }> {
  const token = decryptToken(integration.access_token)
  if (!token) return { ok: false, templates: [], error: "Stored access token could not be read." }

  const out: DetailedWhatsAppTemplate[] = []
  let url: string | null = `${GRAPH_BASE}/${encodeURIComponent(
    integration.waba_id,
  )}/message_templates?fields=id,name,language,status,category,quality_score,rejected_reason,components&limit=100`

  try {
    // Follow paging.next up to a sane cap to avoid runaway loops.
    for (let page = 0; url && page < 20; page++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      const data = (await res.json().catch(() => ({}))) as {
        data?: {
          id?: string
          name: string
          language: string
          status: string
          category?: string
          quality_score?: { score?: string } | string
          rejected_reason?: string
          components?: TemplateComponent[]
        }[]
        paging?: { next?: string }
        error?: { message?: string; code?: number }
      }
      if (!res.ok || data.error) {
        return { ok: false, templates: [], error: parseGraphError(data.error, res.status).message }
      }
      for (const t of data.data ?? []) {
        const quality =
          typeof t.quality_score === "string"
            ? t.quality_score
            : (t.quality_score?.score ?? null)
        out.push({
          metaId: t.id ?? null,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category ?? null,
          qualityScore: quality ? String(quality).toUpperCase() : null,
          rejectedReason: t.rejected_reason ? String(t.rejected_reason) : null,
          components: Array.isArray(t.components) ? t.components : [],
        })
      }
      url = data.paging?.next ?? null
    }
    return { ok: true, templates: out }
  } catch (err) {
    return { ok: false, templates: [], error: (err as Error).message }
  }
}

/** Categories Meta accepts when creating a message template. */
export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION"

/** Fields an employee authors in the ERP to create a new template. */
export type CreateTemplateInput = {
  name: string
  language: string
  category: TemplateCategory
  headerText?: string
  bodyText: string
  footerText?: string
  /** Example values for {{1}}, {{2}}, … placeholders found in the body. */
  bodyExamples?: string[]
}

const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/
const PLACEHOLDER_RE = /\{\{\s*(\d+)\s*\}\}/g

/** Returns the ordered, unique placeholder numbers referenced in a string. */
export function extractPlaceholders(text: string): number[] {
  const found = new Set<number>()
  for (const m of text.matchAll(PLACEHOLDER_RE)) found.add(Number(m[1]))
  return [...found].sort((a, b) => a - b)
}

/**
 * Creates a message template on the connected WABA and submits it to Meta for
 * review. This is the path that lets an employee author templates directly from
 * the ERP without ever logging into the Meta Business Manager: Meta receives the
 * template via the Graph API and returns a PENDING status until it is reviewed.
 *
 * Validates the name format and that every {{n}} placeholder in the body has a
 * matching example (Meta rejects variables without examples), so the employee
 * gets an immediate, friendly error instead of an opaque Graph rejection.
 */
export async function createWhatsAppTemplate(
  integration: WhatsAppIntegrationRow,
  input: CreateTemplateInput,
): Promise<{ ok: boolean; id?: string; status?: string; category?: string; error?: string }> {
  const token = decryptToken(integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  const name = input.name.trim().toLowerCase()
  if (!TEMPLATE_NAME_RE.test(name)) {
    return {
      ok: false,
      error: "Template name may only contain lowercase letters, numbers and underscores.",
    }
  }
  const body = input.bodyText.trim()
  if (!body) return { ok: false, error: "The template body is required." }

  const placeholders = extractPlaceholders(body)
  const examples = (input.bodyExamples ?? []).map((v) => v.trim())
  if (placeholders.length > 0) {
    // Placeholders must be a contiguous 1..N run and each needs an example.
    const expected = placeholders.every((n, i) => n === i + 1)
    if (!expected) {
      return { ok: false, error: "Body variables must be numbered sequentially starting at {{1}}." }
    }
    if (examples.length < placeholders.length || examples.some((v) => !v)) {
      return { ok: false, error: "Provide a sample value for every {{n}} variable used in the body." }
    }
  }

  const components: Record<string, unknown>[] = []
  const headerText = input.headerText?.trim()
  if (headerText) {
    components.push({ type: "HEADER", format: "TEXT", text: headerText })
  }
  const bodyComponent: Record<string, unknown> = { type: "BODY", text: body }
  if (placeholders.length > 0) {
    bodyComponent.example = { body_text: [examples.slice(0, placeholders.length)] }
  }
  components.push(bodyComponent)
  const footerText = input.footerText?.trim()
  if (footerText) {
    components.push({ type: "FOOTER", text: footerText })
  }

  const url = `${GRAPH_BASE}/${encodeURIComponent(integration.waba_id)}/message_templates`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        language: input.language,
        category: input.category,
        components,
      }),
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      id?: string
      status?: string
      category?: string
      error?: { message?: string; type?: string; code?: number; error_subcode?: number }
    }
    if (!res.ok || data.error) {
      return { ok: false, error: parseGraphError(data.error, res.status).message }
    }
    return { ok: true, id: data.id, status: data.status, category: data.category }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/* ------------------------------------------------------------------ */
/* Webhook security helpers                                            */
/* ------------------------------------------------------------------ */

/** The token Meta echoes back during webhook verification (GET handshake). */
export function getWebhookVerifyToken(): string | null {
  return process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim() || null
}

/**
 * The Meta app secret used to sign webhook POST bodies. We accept a dedicated
 * WHATSAPP_APP_SECRET first, then fall back to a shared META_APP_SECRET /
 * FACEBOOK_APP_SECRET if the deployment already configured one.
 */
export function getAppSecret(): string | null {
  return (
    process.env.WHATSAPP_APP_SECRET?.trim() ||
    process.env.META_APP_SECRET?.trim() ||
    process.env.FACEBOOK_APP_SECRET?.trim() ||
    null
  )
}

/**
 * Verifies Meta's `X-Hub-Signature-256` header against the raw request body
 * using HMAC-SHA256 keyed by the app secret. Returns false (never throws) when
 * the secret is missing or the signature does not match. The comparison is
 * constant-time to avoid leaking timing information.
 *
 * Never logs the signature, the body or the secret.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = getAppSecret()
  if (!secret) return false
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  const provided = signatureHeader.slice("sha256=".length)

  // Both must be equal-length hex strings for timingSafeEqual to work.
  const expectedBuf = Buffer.from(expected, "hex")
  const providedBuf = Buffer.from(provided, "hex")
  if (expectedBuf.length !== providedBuf.length || expectedBuf.length === 0) return false

  try {
    return timingSafeEqual(expectedBuf, providedBuf)
  } catch {
    return false
  }
}

/**
 * Subscribes the connected app to the WABA's webhook fields. Meta requires an
 * explicit subscription — a successful GET verification alone does NOT start
 * message delivery. Safe to call repeatedly (idempotent on Meta's side).
 */
export async function subscribeWabaWebhook(
  integration: WhatsAppIntegrationRow,
): Promise<{ ok: boolean; error?: string }> {
  const token = decryptToken(integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  // Standard Cloud API: subscribe to the `messages` field so inbound messages
  // and outbound status updates reach the ERP webhook.
  const subscribedFields = ["messages"].join(",")
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(integration.waba_id)}/subscribed_apps` +
    `?subscribed_fields=${encodeURIComponent(subscribedFields)}`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean
      error?: { message?: string; code?: number }
    }
    if (!res.ok || (data.success === false && data.error)) {
      return { ok: false, error: parseGraphError(data.error, res.status).message }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Reads the WABA's subscribed apps so the status panel can show whether THIS
 * app is actually subscribed to receive webhooks (a successful GET handshake
 * alone does not start delivery). Returns the raw list plus a convenience
 * `subscribed` flag. Never throws — a failure returns ok:false with a message.
 */
export async function getWabaSubscriptionStatus(
  integration: WhatsAppIntegrationRow,
): Promise<{ ok: boolean; subscribed: boolean; appNames: string[]; error?: string }> {
  const token = decryptToken(integration.access_token)
  if (!token) return { ok: false, subscribed: false, appNames: [], error: "Stored access token could not be read." }

  const url = `${GRAPH_BASE}/${encodeURIComponent(integration.waba_id)}/subscribed_apps`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: { whatsapp_business_api_data?: { name?: string; id?: string } }[]
      error?: { message?: string; type?: string; code?: number; error_subcode?: number }
    }
    if (!res.ok || data.error) {
      return { ok: false, subscribed: false, appNames: [], error: parseGraphError(data.error, res.status).message }
    }
    const apps = data.data ?? []
    const appNames = apps
      .map((a) => a.whatsapp_business_api_data?.name)
      .filter((n): n is string => Boolean(n))
    return { ok: true, subscribed: apps.length > 0, appNames }
  } catch (err) {
    return { ok: false, subscribed: false, appNames: [], error: (err as Error).message }
  }
}

/**
 * Resolves a Meta media id to a short-lived download URL. The URL itself must
 * be fetched with the access token, so downloads stay server-side.
 */
export async function getWhatsAppMedia(input: {
  integration: WhatsAppIntegrationRow
  mediaId: string
}): Promise<{ ok: boolean; url?: string; mimeType?: string; error?: string }> {
  const token = decryptToken(input.integration.access_token)
  if (!token) return { ok: false, error: "Stored access token could not be read." }

  const url = `${GRAPH_BASE}/${encodeURIComponent(input.mediaId)}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      url?: string
      mime_type?: string
      error?: { message?: string; code?: number }
    }
    if (!res.ok || data.error) {
      return { ok: false, error: parseGraphError(data.error, res.status).message }
    }
    return { ok: true, url: data.url, mimeType: data.mime_type }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
