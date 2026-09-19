import "server-only"
import { randomBytes } from "node:crypto"
import { query } from "@/lib/db"
import { currentTenantId, currentTenantIdOrNull, runForTenant } from "@/lib/tenant-scope"
import {
  GRAPH_VERSION,
  getAppId,
  exchangeEmbeddedSignupCode,
  verifyWhatsAppCredentials,
  getWabaName,
  upsertWhatsAppIntegration,
  subscribeWabaWebhook,
  getWhatsAppIntegration,
  toPublicIntegration,
  type WhatsAppIntegrationPublic,
} from "@/lib/whatsapp"
import { syncTemplatesFromMeta } from "@/lib/whatsapp-templates"

/**
 * Secure WhatsApp Business "Embedded Signup" onboarding.
 * ---------------------------------------------------------------------------
 * Meta's Embedded Signup returns a short-lived authorization `code` and the
 * ids of the WABA / phone number the tenant admin just created inside Meta's
 * popup. This module turns that into a persisted, tenant-isolated integration:
 *
 *   1. createWhatsAppSignupSession()   — mints a high-entropy CSRF `state` and
 *                                         records which tenant/user started it.
 *   2. resolveTenantFromSignupState()  — looks the `state` back up (the one and
 *                                         only tenant-agnostic read) so the
 *                                         callback knows which tenant to scope
 *                                         to, without trusting client input.
 *   3. handleWhatsAppSignupCallback()  — verifies the state, exchanges the code
 *                                         for a token and connects the account
 *                                         inside that tenant's context.
 *   4. connectWhatsAppBusinessAccount()— persists the integration (WABA id,
 *                                         phone number id, business id, token
 *                                         metadata) encrypted + tenant-scoped,
 *                                         then auto-configures the webhook
 *                                         subscription and syncs templates.
 *
 * The `state` is a 256-bit secret, so looking a session up by it is safe even
 * though that single read is not tenant-scoped (mirrors the webhook's
 * phone-number lookup). The signup-session table is deliberately NOT registered
 * in lib/tenant-tables.ts so the fail-closed guard does not flag that lookup;
 * every row still carries an explicit tenant_id and every write is stamped.
 */

/** How long a started signup may sit before it must be restarted. */
const SESSION_TTL_MS = 15 * 60 * 1000

let tableEnsured = false

async function ensureSignupTable() {
  if (tableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_signup_sessions\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`state\` VARCHAR(191) NOT NULL,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED DEFAULT NULL,
      \`status\` VARCHAR(20) NOT NULL DEFAULT 'pending',
      \`waba_id\` VARCHAR(191) DEFAULT NULL,
      \`phone_number_id\` VARCHAR(191) DEFAULT NULL,
      \`business_id\` VARCHAR(191) DEFAULT NULL,
      \`error\` TEXT DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`expires_at\` TIMESTAMP NULL DEFAULT NULL,
      \`completed_at\` TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_signup_state\` (\`state\`),
      KEY \`idx_wa_signup_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  tableEnsured = true
}

/**
 * The Meta "configuration id" that pins the Embedded Signup flow to a specific
 * WhatsApp onboarding configuration in the Meta app dashboard. Read server-side
 * and handed to the client so no NEXT_PUBLIC_ variant is required.
 */
export function getSignupConfigId(): string | null {
  return (
    process.env.WHATSAPP_CONFIG_ID?.trim() ||
    process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID?.trim() ||
    process.env.META_CONFIG_ID?.trim() ||
    null
  )
}

export type SignupSessionRow = {
  id: number
  state: string
  tenant_id: number
  user_id: number | null
  status: "pending" | "completed" | "failed" | "expired"
  waba_id: string | null
  phone_number_id: string | null
  business_id: string | null
  error: string | null
  created_at: string
  expires_at: string | null
  completed_at: string | null
}

export type StartSignupResult = {
  /** High-entropy CSRF token the client echoes back on the callback. */
  state: string
  /** Meta app id used to launch the Embedded Signup popup (may be null). */
  appId: string | null
  /** Embedded Signup configuration id (may be null if not configured). */
  configId: string | null
  /** Graph API version the client should init the JS SDK with. */
  graphVersion: string
  /** ISO timestamp after which the state is rejected. */
  expiresAt: string
  /** True when the server has everything it needs to launch Embedded Signup. */
  ready: boolean
}

/**
 * 1) Starts a signup for the CURRENT tenant. Persists a `state -> tenant/user`
 * mapping so the callback can be trusted without accepting a tenant id from the
 * client. Must be called inside an authenticated (tenant) request.
 */
export async function createWhatsAppSignupSession(userId: number): Promise<StartSignupResult> {
  await ensureSignupTable()
  const tenantId = currentTenantId()
  const state = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const expiresSql = expiresAt.toISOString().slice(0, 19).replace("T", " ")

  await query(
    `INSERT INTO \`marketing_whatsapp_signup_sessions\`
       (state, tenant_id, user_id, status, expires_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    [state, tenantId, userId, expiresSql],
  )

  const appId = getAppId()
  const configId = getSignupConfigId()
  return {
    state,
    appId,
    configId,
    graphVersion: GRAPH_VERSION,
    expiresAt: expiresAt.toISOString(),
    ready: Boolean(appId && configId),
  }
}

/**
 * Start Embedded Signup for a legacy/system administrator that has no home
 * tenant in the session. This is intentionally narrow: we bind the request
 * only to the single active platform-owner tenant, never to an arbitrary
 * tenant or to the first row returned by the database.
 *
 * Normal tenant administrators continue to use the tenant context populated
 * by getSession(). The fallback exists for the original System Admin account,
 * which predates the tenant-role rollout and therefore has tenant_id = NULL.
 */
export async function createWhatsAppSignupSessionForSystemAdmin(userId: number): Promise<StartSignupResult> {
  const currentTenant = currentTenantIdOrNull()
  if (currentTenant != null) {
    return createWhatsAppSignupSession(userId)
  }

  const owners = await query<{ id: number }[]>(
    `SELECT \`id\`
       FROM \`tenants\`
      WHERE \`status\` = 'active' AND \`is_platform_owner\` = 1
      ORDER BY \`id\` ASC`,
  )

  if (owners.length !== 1) {
    throw new Error(
      owners.length === 0
        ? "System Admin signup requires an active platform-owner tenant."
        : "System Admin signup requires exactly one active platform-owner tenant.",
    )
  }

  return runForTenant({ tenantId: Number(owners[0].id) }, () => createWhatsAppSignupSession(userId))
}

/**
 * 2) Resolves which tenant/user a `state` belongs to. This is the ONLY
 * tenant-agnostic read in the flow and exists purely so the callback — which
 * must trust the signed state, never a client-supplied tenant id — can enter
 * the right tenant's context. Returns null when the state is unknown, already
 * consumed, or expired (fail closed).
 */
export async function resolveTenantFromSignupState(
  state: string,
): Promise<{ id: number; tenantId: number; userId: number | null } | null> {
  const clean = state?.trim()
  if (!clean) return null
  await ensureSignupTable()

  const rows = await query<SignupSessionRow[]>(
    "SELECT * FROM `marketing_whatsapp_signup_sessions` WHERE `state` = ? LIMIT 1",
    [clean],
  )
  const row = rows[0]
  if (!row) return null
  if (row.status !== "pending") return null
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await query("UPDATE `marketing_whatsapp_signup_sessions` SET `status` = 'expired' WHERE `id` = ?", [row.id])
    return null
  }
  return { id: row.id, tenantId: row.tenant_id, userId: row.user_id }
}

async function markSignupSession(
  id: number,
  status: "completed" | "failed",
  patch: { wabaId?: string | null; phoneNumberId?: string | null; businessId?: string | null; error?: string | null },
) {
  await query(
    `UPDATE \`marketing_whatsapp_signup_sessions\`
       SET \`status\` = ?, \`waba_id\` = ?, \`phone_number_id\` = ?, \`business_id\` = ?,
           \`error\` = ?, \`completed_at\` = NOW()
     WHERE \`id\` = ?`,
    [status, patch.wabaId ?? null, patch.phoneNumberId ?? null, patch.businessId ?? null, patch.error ?? null, id],
  )
}

export type ConnectResult = {
  ok: boolean
  error?: string
  integration?: WhatsAppIntegrationPublic
  autoConfig?: {
    webhookSubscribed: boolean
    webhookError?: string
    templatesSynced: number
    templatesError?: string
  }
}

/**
 * 4) Persists a verified WhatsApp Business account for the CURRENT tenant and
 * auto-configures it. Must be called inside a tenant context (a session request
 * or a runForTenant() block). Steps:
 *   - Validate the token live against the phone number (never store a set that
 *     cannot send), capturing the display number / verified name / quality.
 *   - Store WABA id, phone number id, business id + the ENCRYPTED token,
 *     tenant-scoped, via the existing upsert (idempotent per tenant+number).
 *   - Subscribe the app to the WABA webhook so inbound messages actually flow.
 *   - Sync the template catalog so the tenant can send immediately.
 * Auto-config steps are best-effort: a failure there never fails the connect,
 * it is surfaced so the UI can prompt a retry.
 */
export async function connectWhatsAppBusinessAccount(input: {
  userId: number | null
  accessToken: string
  wabaId: string
  phoneNumberId: string
  businessId?: string | null
  businessName?: string | null
}): Promise<ConnectResult> {
  const wabaId = input.wabaId?.trim()
  const phoneNumberId = input.phoneNumberId?.trim()
  const accessToken = input.accessToken?.trim()
  if (!wabaId || !phoneNumberId || !accessToken) {
    return { ok: false, error: "WhatsApp Business Account ID, Phone Number ID and access token are all required." }
  }

  // Live verification — this is the real "will Meta accept this token" test.
  let profile
  try {
    profile = await verifyWhatsAppCredentials({ phoneNumberId, accessToken })
  } catch (err) {
    return { ok: false, error: `Meta rejected these credentials: ${(err as Error).message}` }
  }

  const businessName = input.businessName?.trim() || (await getWabaName({ wabaId, accessToken })) || null

  await upsertWhatsAppIntegration({
    wabaId,
    phoneNumberId,
    displayPhoneNumber: profile.displayPhoneNumber,
    verifiedName: profile.verifiedName,
    businessName,
    qualityRating: profile.qualityRating,
    platformType: profile.platformType,
    accessToken,
    connectedByUserId: input.userId,
  })

  const row = await getWhatsAppIntegration()
  if (!row) {
    return { ok: false, error: "The integration was saved but could not be read back." }
  }

  // Best-effort auto-configuration: subscribe the webhook and sync templates.
  let webhookSubscribed = false
  let webhookError: string | undefined
  try {
    const sub = await subscribeWabaWebhook(row)
    webhookSubscribed = sub.ok
    if (!sub.ok) webhookError = sub.error
  } catch (err) {
    webhookError = (err as Error).message
  }

  let templatesSynced = 0
  let templatesError: string | undefined
  try {
    const synced = await syncTemplatesFromMeta(row)
    if (synced.ok) templatesSynced = synced.total
    else templatesError = synced.error
  } catch (err) {
    templatesError = (err as Error).message
  }

  return {
    ok: true,
    integration: toPublicIntegration(row),
    autoConfig: { webhookSubscribed, webhookError, templatesSynced, templatesError },
  }
}

/**
 * 3) Handles the Embedded Signup callback. Trusts ONLY the `state` (not any
 * client-supplied tenant id) to decide which tenant this belongs to, exchanges
 * the authorization code for a business token, and connects the account inside
 * that tenant's context. `expectedTenantId` (the acting session's tenant, when
 * present) is cross-checked so a signed-in user of tenant A can never redeem a
 * state started by tenant B.
 */
export async function handleWhatsAppSignupCallback(input: {
  state: string
  code: string
  wabaId: string
  phoneNumberId: string
  businessId?: string | null
  expectedTenantId?: number | null
  expectedUserId?: number | null
}): Promise<ConnectResult> {
  const resolved = await resolveTenantFromSignupState(input.state)
  if (!resolved) {
    return { ok: false, error: "This WhatsApp signup link has expired or is invalid. Please start again." }
  }
  if (input.expectedTenantId != null && input.expectedTenantId !== resolved.tenantId) {
    // Never let one tenant consume another tenant's signup state.
    return { ok: false, error: "This WhatsApp signup does not belong to your organization." }
  }
  if (input.expectedUserId != null && input.expectedUserId !== resolved.userId) {
    return { ok: false, error: "This WhatsApp signup was started by another administrator." }
  }

  const code = input.code?.trim()
  if (!code) {
    await markSignupSession(resolved.id, "failed", { error: "Missing authorization code." })
    return { ok: false, error: "Meta did not return an authorization code. Please try connecting again." }
  }

  const exchange = await exchangeEmbeddedSignupCode(code)
  if (!exchange.ok || !exchange.accessToken) {
    const error = exchange.error || "Could not exchange the authorization code for an access token."
    await markSignupSession(resolved.id, "failed", { error })
    return { ok: false, error }
  }

  // Enter the resolved tenant's context so upsert/subscribe/sync are all scoped.
  const result = await runForTenant({ tenantId: resolved.tenantId }, () =>
    connectWhatsAppBusinessAccount({
      userId: resolved.userId,
      accessToken: exchange.accessToken as string,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      businessId: input.businessId ?? null,
    }),
  )

  await markSignupSession(resolved.id, result.ok ? "completed" : "failed", {
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    businessId: input.businessId ?? null,
    error: result.ok ? null : result.error ?? "Connection failed.",
  })

  return result
}
