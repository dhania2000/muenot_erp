import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"
import { query } from "@/lib/db"
import { encryptToken, decryptToken } from "@/lib/token-crypto"

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
export const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION?.trim() || "v23.0"
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
    message = `${base}. This number is not connected to the WhatsApp Cloud API yet — use "Connect WhatsApp Business App" to run Meta's coexistence onboarding (QR scan), then try again.`
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
 * evolve the integration table (coexistence fields) without a manual migration.
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
      \`waba_id\` VARCHAR(191) NOT NULL,
      \`phone_number_id\` VARCHAR(191) NOT NULL,
      \`display_phone_number\` VARCHAR(64) DEFAULT NULL,
      \`verified_name\` VARCHAR(191) DEFAULT NULL,
      \`business_name\` VARCHAR(191) DEFAULT NULL,
      \`quality_rating\` VARCHAR(32) DEFAULT NULL,
      \`platform_type\` VARCHAR(32) DEFAULT NULL,
      \`is_on_biz_app\` TINYINT(1) DEFAULT NULL,
      \`access_token\` TEXT NOT NULL,
      \`connected_by_user_id\` INT UNSIGNED DEFAULT NULL,
      \`connected_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_phone_number\` (\`phone_number_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Older deployments predate the coexistence columns — add them idempotently.
  await ensureColumn(
    "marketing_whatsapp_integration",
    "platform_type",
    "`platform_type` VARCHAR(32) DEFAULT NULL",
  )
  await ensureColumn(
    "marketing_whatsapp_integration",
    "is_on_biz_app",
    "`is_on_biz_app` TINYINT(1) DEFAULT NULL",
  )
  tableEnsured = true
}

export type WhatsAppIntegrationRow = {
  id: number
  waba_id: string
  phone_number_id: string
  display_phone_number: string | null
  verified_name: string | null
  business_name: string | null
  quality_rating: string | null
  platform_type: string | null
  is_on_biz_app: number | null
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
  qualityRating: string | null
  platformType: string | null
  /** True when this number also runs in the WhatsApp Business App (coexistence). */
  coexistence: boolean
  connectedAt: string
}

export function toPublicIntegration(row: WhatsAppIntegrationRow): WhatsAppIntegrationPublic {
  return {
    id: row.id,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    businessName: row.business_name,
    qualityRating: row.quality_rating,
    platformType: row.platform_type,
    coexistence: row.is_on_biz_app === 1,
    connectedAt: row.connected_at,
  }
}

/**
 * Builds an integration row from the server environment when an administrator
 * has provisioned the coexistence number via env vars instead of the UI.
 *
 * This is the admin-only backend configuration path (see section 19/20 of the
 * spec): the WhatsApp Business App number stays live and we NEVER call
 * `/register`. The access token is read from the env only on the server and is
 * treated as plaintext by decryptToken (it has no `enc:v1:` marker), so no key
 * is needed. Returns null unless the three core identifiers are all present.
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
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    display_phone_number: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER?.trim() || null,
    verified_name: businessName,
    business_name: businessName,
    quality_rating: null,
    // Signals coexistence so the UI shows the "also on the Business App" badge.
    platform_type: "SMB_COEXISTENCE",
    is_on_biz_app: 1,
    access_token: accessToken,
    connected_by_user_id: null,
    connected_at: now,
    updated_at: now,
  }
}

/**
 * Returns the active WhatsApp integration. A row saved through the UI (Embedded
 * Signup or manual credentials) takes precedence; otherwise we fall back to the
 * env-provisioned coexistence number so the connection works out of the box.
 */
export async function getWhatsAppIntegration(): Promise<WhatsAppIntegrationRow | null> {
  await ensureWhatsAppTable()
  const rows = await query<WhatsAppIntegrationRow[]>(
    "SELECT * FROM `marketing_whatsapp_integration` ORDER BY connected_at DESC LIMIT 1",
  )
  return rows[0] ?? getEnvIntegration()
}

export type PhoneNumberProfile = {
  displayPhoneNumber: string | null
  verifiedName: string | null
  qualityRating: string | null
  /** CLOUD_API | ON_PREMISE | NOT_APPLICABLE (when Meta reports it). */
  platformType: string | null
  /** True when the number is also active in the WhatsApp Business App (coexistence). */
  isOnBizApp: boolean | null
}

type RawPhoneProfile = {
  display_phone_number?: string
  verified_name?: string
  quality_rating?: string
  platform_type?: string
  is_on_biz_app?: boolean
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
    })
  } catch (err) {
    throw new Error(`Could not reach the WhatsApp API: ${(err as Error).message}`)
  }
  const data = (await res.json().catch(() => ({}))) as RawPhoneProfile
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Graph API returned ${res.status}`)
  }
  return data
}

/**
 * Validates the credentials by asking the Graph API for the phone number's
 * profile, including the coexistence signals `platform_type` and
 * `is_on_biz_app`. Some numbers / API versions do not expose those extra
 * fields, so we transparently retry with the base field set rather than
 * failing the connect flow. Throws a human-friendly message when Meta rejects
 * the credentials outright.
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
      "display_phone_number,verified_name,quality_rating,platform_type,is_on_biz_app",
    )
  } catch {
    // Retry with the base fields (covers numbers/versions without coexistence fields
    // and re-surfaces a genuine auth error from the second attempt).
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
    isOnBizApp: typeof data.is_on_biz_app === "boolean" ? data.is_on_biz_app : null,
  }
}

export type ConnectWhatsApp = {
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string | null
  verifiedName: string | null
  businessName: string | null
  qualityRating: string | null
  platformType: string | null
  isOnBizApp: boolean | null
  accessToken: string
  connectedByUserId: number | null
}

export async function upsertWhatsAppIntegration(data: ConnectWhatsApp) {
  await ensureWhatsAppTable()
  await query(
    `INSERT INTO \`marketing_whatsapp_integration\`
      (waba_id, phone_number_id, display_phone_number, verified_name, business_name,
       quality_rating, platform_type, is_on_biz_app, access_token, connected_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       waba_id = VALUES(waba_id),
       display_phone_number = VALUES(display_phone_number),
       verified_name = VALUES(verified_name),
       business_name = VALUES(business_name),
       quality_rating = VALUES(quality_rating),
       platform_type = VALUES(platform_type),
       is_on_biz_app = VALUES(is_on_biz_app),
       access_token = VALUES(access_token),
       connected_by_user_id = VALUES(connected_by_user_id)`,
    [
      data.wabaId,
      data.phoneNumberId,
      data.displayPhoneNumber,
      data.verifiedName,
      data.businessName,
      data.qualityRating,
      data.platformType,
      data.isOnBizApp == null ? null : data.isOnBizApp ? 1 : 0,
      encryptToken(data.accessToken),
      data.connectedByUserId,
    ],
  )
}

export async function deleteWhatsAppIntegration(id: number) {
  await ensureWhatsAppTable()
  await query("DELETE FROM `marketing_whatsapp_integration` WHERE id = ?", [id])
}

/* ------------------------------------------------------------------ */
/* Embedded Signup (coexistence / QR onboarding)                       */
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
 * Signup popup for a business access token, using the app id + app secret. This
 * is the coexistence onboarding path: the QR scan and number selection happen
 * inside Meta's popup, so we NEVER call `/{phone-number-id}/register` and NEVER
 * deregister the number — the WhatsApp Business App number and its coexistence
 * stay intact. The returned token is what we store (encrypted) and use for all
 * subsequent Graph API calls.
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

  const url = `${GRAPH_BASE}/${encodeURIComponent(integration.waba_id)}/subscribed_apps`
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
