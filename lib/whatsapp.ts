import "server-only"
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

const GRAPH_VERSION = "v21.0"
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

let tableEnsured = false

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
      \`access_token\` TEXT NOT NULL,
      \`connected_by_user_id\` INT UNSIGNED DEFAULT NULL,
      \`connected_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_phone_number\` (\`phone_number_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
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
    connectedAt: row.connected_at,
  }
}

/** Returns the most recently connected WhatsApp integration, if any. */
export async function getWhatsAppIntegration(): Promise<WhatsAppIntegrationRow | null> {
  await ensureWhatsAppTable()
  const rows = await query<WhatsAppIntegrationRow[]>(
    "SELECT * FROM `marketing_whatsapp_integration` ORDER BY connected_at DESC LIMIT 1",
  )
  return rows[0] ?? null
}

export type PhoneNumberProfile = {
  displayPhoneNumber: string | null
  verifiedName: string | null
  qualityRating: string | null
}

/**
 * Validates the supplied credentials by asking the Graph API for the phone
 * number's profile. Throws with a human-friendly message on failure so the
 * connect flow can surface exactly why Meta rejected the credentials.
 */
export async function verifyWhatsAppCredentials(input: {
  phoneNumberId: string
  accessToken: string
}): Promise<PhoneNumberProfile> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(
    input.phoneNumberId,
  )}?fields=display_phone_number,verified_name,quality_rating`

  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      cache: "no-store",
    })
  } catch (err) {
    throw new Error(`Could not reach the WhatsApp API: ${(err as Error).message}`)
  }

  const data = (await res.json().catch(() => ({}))) as {
    display_phone_number?: string
    verified_name?: string
    quality_rating?: string
    error?: { message?: string; type?: string; code?: number }
  }

  if (!res.ok || data.error) {
    const msg = data.error?.message || `Graph API returned ${res.status}`
    throw new Error(msg)
  }

  return {
    displayPhoneNumber: data.display_phone_number ?? null,
    verifiedName: data.verified_name ?? null,
    qualityRating: data.quality_rating ?? null,
  }
}

export type ConnectWhatsApp = {
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string | null
  verifiedName: string | null
  businessName: string | null
  qualityRating: string | null
  accessToken: string
  connectedByUserId: number | null
}

export async function upsertWhatsAppIntegration(data: ConnectWhatsApp) {
  await ensureWhatsAppTable()
  await query(
    `INSERT INTO \`marketing_whatsapp_integration\`
      (waba_id, phone_number_id, display_phone_number, verified_name, business_name,
       quality_rating, access_token, connected_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       waba_id = VALUES(waba_id),
       display_phone_number = VALUES(display_phone_number),
       verified_name = VALUES(verified_name),
       business_name = VALUES(business_name),
       quality_rating = VALUES(quality_rating),
       access_token = VALUES(access_token),
       connected_by_user_id = VALUES(connected_by_user_id)`,
    [
      data.wabaId,
      data.phoneNumberId,
      data.displayPhoneNumber,
      data.verifiedName,
      data.businessName,
      data.qualityRating,
      encryptToken(data.accessToken),
      data.connectedByUserId,
    ],
  )
}

export async function deleteWhatsAppIntegration(id: number) {
  await ensureWhatsAppTable()
  await query("DELETE FROM `marketing_whatsapp_integration` WHERE id = ?", [id])
}

export type SendResult = {
  ok: boolean
  messageId?: string
  error?: string
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
      error?: { message?: string }
    }
    if (!res.ok || data.error) {
      return { ok: false, error: data.error?.message || `Graph API returned ${res.status}` }
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
      error?: { message?: string }
    }
    if (!res.ok || data.error) {
      return { ok: false, error: data.error?.message || `Graph API returned ${res.status}` }
    }
    return { ok: true, messageId: data.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
