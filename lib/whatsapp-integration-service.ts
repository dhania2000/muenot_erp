import "server-only"

/**
 * Multi-WABA integration service (Spec 2).
 *
 * The canonical, tenant-scoped lifecycle API for WhatsApp Business integrations.
 * A tenant may connect MANY numbers/WABAs; each is a distinct row with its own
 * `integration_id`. Every function here derives the tenant from the verified
 * session/job context (never from client input) and only ever touches rows that
 * belong to that tenant, so cross-tenant access is impossible through any API or
 * background job that goes through this service.
 *
 * Credentials are stored encrypted (see token-crypto) and are NEVER returned:
 * every value handed back to a caller is the `WhatsAppIntegrationPublic` shape,
 * which omits the access token entirely.
 *
 * This module intentionally exposes the spec's canonical names
 * (createIntegration / getTenantIntegration / getIntegrationByIdForTenant /
 * disconnectIntegration / refreshIntegrationCredentials) and delegates to the
 * lower-level helpers in lib/whatsapp.ts so there is a single, well-named entry
 * point for integration management.
 */

import {
  getWhatsAppIntegrationForTenant,
  getWhatsAppIntegrationByIdForTenant,
  listWhatsAppIntegrationsForTenant,
  upsertWhatsAppIntegration,
  deleteWhatsAppIntegration,
  verifyWhatsAppCredentials,
  subscribeWabaWebhook,
  toPublicIntegration,
  type WhatsAppIntegrationRow,
  type WhatsAppIntegrationPublic,
} from "@/lib/whatsapp"
import { getConnectionHealth, type ConnectionHealth } from "@/lib/whatsapp-health"
import { currentTenantId } from "@/lib/tenant-scope"

export type { WhatsAppIntegrationPublic } from "@/lib/whatsapp"

export type CreateIntegrationInput = {
  wabaId: string
  phoneNumberId: string
  accessToken: string
  businessName?: string | null
  businessId?: string | null
  connectedByUserId: number | null
}

/**
 * Connects (or updates) a WhatsApp number for the CURRENT tenant.
 *
 * Credentials are verified against the Graph API first so we never persist a
 * set that cannot actually send, then stored encrypted and stamped with the
 * tenant. The app is subscribed to the WABA webhook so inbound messages arrive
 * (best-effort; a subscription failure does not fail the connect). Returns the
 * public shape — never the token. Throws with Meta's own message when the
 * credentials are rejected.
 */
export async function createIntegration(
  input: CreateIntegrationInput,
): Promise<WhatsAppIntegrationPublic> {
  const wabaId = input.wabaId.trim()
  const phoneNumberId = input.phoneNumberId.trim()
  const accessToken = input.accessToken.trim()
  if (!wabaId || !phoneNumberId || !accessToken) {
    throw new Error("WABA ID, Phone Number ID and Access Token are all required.")
  }

  const profile = await verifyWhatsAppCredentials({ phoneNumberId, accessToken })

  await upsertWhatsAppIntegration({
    wabaId,
    phoneNumberId,
    displayPhoneNumber: profile.displayPhoneNumber,
    verifiedName: profile.verifiedName,
    businessName: input.businessName?.trim() || profile.verifiedName || null,
    businessId: input.businessId?.trim() || null,
    qualityRating: profile.qualityRating,
    platformType: profile.platformType,
    accessToken,
    connectedByUserId: input.connectedByUserId,
  })

  // Re-read the freshly-stored row (tenant-scoped) so we return real ids/dates.
  const row = await requireByPhoneNumberId(phoneNumberId)
  // Best-effort webhook subscription — never blocks the connect flow.
  await subscribeWabaWebhook(row).catch(() => undefined)
  return toPublicIntegration(row)
}

/** The tenant's active (most-recently connected) integration, or null. */
export async function getTenantIntegration(): Promise<WhatsAppIntegrationPublic | null> {
  const row = await getWhatsAppIntegrationForTenant(currentTenantId())
  return row ? toPublicIntegration(row) : null
}

/** Every integration owned by the current tenant (multi-WABA list). */
export async function listTenantIntegrations(): Promise<WhatsAppIntegrationPublic[]> {
  const rows = await listWhatsAppIntegrationsForTenant()
  return rows.map(toPublicIntegration)
}

/**
 * A specific integration by id, scoped to the current tenant. Returns null for
 * a foreign/forged id — the caller can treat that as 404 (IDOR-safe).
 */
export async function getIntegrationByIdForTenant(
  id: number,
): Promise<WhatsAppIntegrationPublic | null> {
  const row = await getWhatsAppIntegrationByIdForTenant(id)
  return row ? toPublicIntegration(row) : null
}

/**
 * Disconnects one of the current tenant's integrations by id. The delete is
 * tenant-scoped, so a forged id can never remove another tenant's number.
 * Returns true when a row was actually owned and removed.
 */
export async function disconnectIntegration(id: number): Promise<boolean> {
  const row = await getWhatsAppIntegrationByIdForTenant(id)
  if (!row) return false
  await deleteWhatsAppIntegration(id)
  return true
}

export type RefreshIntegrationInput = {
  /** Optional new access token (reconnect with a fresh token from Meta). */
  accessToken?: string | null
}

/**
 * Re-validates an integration's credentials against Meta and refreshes the
 * stored profile (display number, verified name, quality rating, platform type)
 * and, when a new token is supplied, the encrypted access token. Also re-asserts
 * the WABA webhook subscription. Tenant-scoped by id, so it can only ever touch
 * the current tenant's number. Throws with Meta's message when the credentials
 * are rejected; returns the refreshed public shape on success.
 */
export async function refreshIntegrationCredentials(
  id: number,
  input: RefreshIntegrationInput = {},
): Promise<WhatsAppIntegrationPublic> {
  const row = await getWhatsAppIntegrationByIdForTenant(id)
  if (!row) throw new Error("Integration not found for this tenant.")

  const newToken = input.accessToken?.trim()
  const tokenToUse = newToken || decryptExisting(row)
  if (!tokenToUse) {
    throw new Error("No usable access token — provide a new token to reconnect this number.")
  }

  const profile = await verifyWhatsAppCredentials({
    phoneNumberId: row.phone_number_id,
    accessToken: tokenToUse,
  })

  await upsertWhatsAppIntegration({
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: profile.displayPhoneNumber,
    verifiedName: profile.verifiedName,
    businessName: row.business_name,
    businessId: row.business_id,
    qualityRating: profile.qualityRating,
    platformType: profile.platformType,
    accessToken: tokenToUse,
    connectedByUserId: row.connected_by_user_id,
  })

  const refreshed = await requireByPhoneNumberId(row.phone_number_id)
  await subscribeWabaWebhook(refreshed).catch(() => undefined)
  return toPublicIntegration(refreshed)
}

/**
 * Live health for one of the current tenant's integrations (connect/quality/
 * webhook/registration checks). Tenant-scoped by id; returns null for a
 * foreign/forged id.
 */
export async function testIntegration(id: number): Promise<ConnectionHealth | null> {
  const row = await getWhatsAppIntegrationByIdForTenant(id)
  if (!row) return null
  return getConnectionHealth(row)
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** Reads back a just-written row by phone number id, scoped to this tenant. */
async function requireByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppIntegrationRow> {
  const rows = await listWhatsAppIntegrationsForTenant()
  const row = rows.find((r) => r.phone_number_id === phoneNumberId)
  if (!row) throw new Error("Integration could not be read back after saving.")
  return row
}

/** Lazily import decryptToken to keep this module's import surface small. */
function decryptExisting(row: WhatsAppIntegrationRow): string {
  // token-crypto is server-only and already used across the WhatsApp libs.
  const { decryptToken } = require("@/lib/token-crypto") as typeof import("@/lib/token-crypto")
  return decryptToken(row.access_token) || ""
}
