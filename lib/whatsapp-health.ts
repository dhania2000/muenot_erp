import "server-only"
import { query } from "@/lib/db"
import {
  getWhatsAppIntegration,
  verifyWhatsAppCredentials,
  getWabaSubscriptionStatus,
  getWhatsAppTemplates,
  toPublicIntegration,
  type WhatsAppIntegrationRow,
} from "@/lib/whatsapp"
import { decryptToken } from "@/lib/token-crypto"
import { getWebhookUrl } from "@/lib/whatsapp-config"

/**
 * Real connection health for the WhatsApp number — NEVER a hardcoded
 * "Connected". Every field below is derived from a live Graph API probe or a
 * database fact, so the Overview/Settings panels reflect the true state.
 */

export type HealthCheck = {
  id: string
  label: string
  status: "ok" | "warn" | "error" | "unknown"
  detail: string
}

export type ConnectionHealth = {
  connected: boolean
  overall: "healthy" | "degraded" | "down" | "disconnected"
  integration: ReturnType<typeof toPublicIntegration> | null
  webhookUrl: string
  checks: HealthCheck[]
  phone: {
    displayPhoneNumber: string | null
    verifiedName: string | null
    qualityRating: string | null
    platformType: string | null
    coexistence: boolean | null
  } | null
  webhook: {
    lastEventAt: string | null
    lastErrorAt: string | null
    lastError: string | null
    eventsLast24h: number
  }
  templates: { approved: number; total: number }
  checkedAt: string
}

async function webhookStats(): Promise<ConnectionHealth["webhook"]> {
  try {
    const rows = await query<
      { last_event: string | null; last_error_at: string | null; last_error: string | null; events_24h: number }[]
    >(
      `SELECT
         MAX(received_at) AS last_event,
         MAX(CASE WHEN processing_status = 'error' THEN received_at END) AS last_error_at,
         SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN processing_status = 'error' THEN error END ORDER BY received_at DESC SEPARATOR '||'), '||', 1) AS last_error,
         SUM(received_at >= (NOW() - INTERVAL 24 HOUR)) AS events_24h
       FROM \`marketing_whatsapp_webhook_events\``,
    )
    const r = rows[0]
    return {
      lastEventAt: r?.last_event ?? null,
      lastErrorAt: r?.last_error_at ?? null,
      lastError: r?.last_error ?? null,
      eventsLast24h: Number(r?.events_24h) || 0,
    }
  } catch {
    return { lastEventAt: null, lastErrorAt: null, lastError: null, eventsLast24h: 0 }
  }
}

function qualityStatus(rating: string | null): HealthCheck["status"] {
  if (!rating) return "unknown"
  const r = rating.toUpperCase()
  if (r === "GREEN" || r === "HIGH") return "ok"
  if (r === "YELLOW" || r === "MEDIUM") return "warn"
  if (r === "RED" || r === "LOW") return "error"
  return "unknown"
}

export async function getConnectionHealth(): Promise<ConnectionHealth> {
  const checkedAt = new Date().toISOString()
  const integration = await getWhatsAppIntegration()

  if (!integration) {
    return {
      connected: false,
      overall: "disconnected",
      integration: null,
      webhookUrl: getWebhookUrl(),
      checks: [
        {
          id: "credentials",
          label: "WhatsApp account",
          status: "error",
          detail: "No WhatsApp Business number is connected yet.",
        },
      ],
      phone: null,
      webhook: await webhookStats(),
      templates: { approved: 0, total: 0 },
      checkedAt,
    }
  }

  const checks: HealthCheck[] = []

  // 1) Token readable at rest.
  const tokenReadable = Boolean(decryptToken(integration.access_token))
  checks.push({
    id: "token",
    label: "Access token",
    status: tokenReadable ? "ok" : "error",
    detail: tokenReadable ? "Stored securely and readable." : "The stored token could not be decrypted.",
  })

  // 2) Live phone-number probe (this is the real "is Meta accepting the token" test).
  let phone: ConnectionHealth["phone"] = null
  let phoneOk = false
  try {
    const profile = await verifyWhatsAppCredentials({
      phoneNumberId: integration.phone_number_id,
      accessToken: decryptToken(integration.access_token) || "",
    })
    phoneOk = true
    phone = {
      displayPhoneNumber: profile.displayPhoneNumber,
      verifiedName: profile.verifiedName,
      qualityRating: profile.qualityRating,
      platformType: profile.platformType,
      coexistence: profile.isOnBizApp,
    }
    checks.push({
      id: "api",
      label: "Cloud API reachable",
      status: "ok",
      detail: `Meta accepted the token for ${profile.displayPhoneNumber || integration.phone_number_id}.`,
    })
    checks.push({
      id: "quality",
      label: "Number quality rating",
      status: qualityStatus(profile.qualityRating),
      detail: profile.qualityRating ? `Meta reports "${profile.qualityRating}".` : "Not reported by Meta.",
    })

    // Cloud API messaging registration — the real antidote to a silent
    // (#133010) "Account not registered" at send time. Meta only reports
    // `status: "CONNECTED"` once the number is actually registered/usable on
    // the Cloud API. Anything else (or an unreported status) means messaging
    // is not confirmed and the coexistence onboarding likely needs to run.
    const status = (profile.status || "").toUpperCase()
    checks.push({
      id: "registration",
      label: "Cloud API messaging",
      status: status === "CONNECTED" ? "ok" : status ? "error" : "warn",
      detail:
        status === "CONNECTED"
          ? "Number is registered on the Cloud API and can send/receive messages."
          : status
            ? `Meta reports status "${status}" — Cloud API messaging is not registered. Run "Connect WhatsApp Business App" to complete coexistence onboarding.`
            : "Meta did not report a registration status. If sending fails with (#133010), run \u201CConnect WhatsApp Business App\u201D to complete coexistence onboarding.",
    })

    // WhatsApp Business App coexistence — asserted ONLY from Meta's live
    // `is_on_biz_app` signal, never inferred from env vars.
    checks.push({
      id: "coexistence",
      label: "Business App coexistence",
      status: profile.isOnBizApp === true ? "ok" : profile.isOnBizApp === false ? "warn" : "unknown",
      detail:
        profile.isOnBizApp === true
          ? "Meta confirms this number also runs in the WhatsApp Business App (coexistence active)."
          : profile.isOnBizApp === false
            ? "Meta reports this number is not running in the WhatsApp Business App. Coexistence onboarding is incomplete."
            : "Meta did not report a coexistence state for this number yet.",
    })
  } catch (err) {
    checks.push({
      id: "api",
      label: "Cloud API reachable",
      status: "error",
      detail: (err as Error).message,
    })
  }

  // 3) Webhook subscription (are we actually going to receive messages?).
  const sub = await getWabaSubscriptionStatus(integration)
  checks.push({
    id: "subscription",
    label: "Webhook subscription",
    status: sub.ok ? (sub.subscribed ? "ok" : "warn") : "error",
    detail: sub.ok
      ? sub.subscribed
        ? `App subscribed to this WABA${sub.appNames.length ? ` (${sub.appNames.join(", ")})` : ""}.`
        : "No app is subscribed — inbound messages will not arrive until you subscribe."
      : sub.error || "Could not read the subscription status.",
  })

  // 4) Webhook traffic (has Meta ever actually delivered to us?).
  const webhook = await webhookStats()
  checks.push({
    id: "webhook_traffic",
    label: "Webhook delivery",
    status: webhook.lastEventAt ? "ok" : "warn",
    detail: webhook.lastEventAt
      ? `Last event ${webhook.lastEventAt} · ${webhook.eventsLast24h} in the last 24h.`
      : "No webhook events received yet.",
  })

  // 5) Templates available.
  let templates = { approved: 0, total: 0 }
  const tpl = await getWhatsAppTemplates(integration)
  if (tpl.ok) {
    templates = {
      approved: tpl.templates.filter((t) => t.status.toUpperCase() === "APPROVED").length,
      total: tpl.templates.length,
    }
    checks.push({
      id: "templates",
      label: "Message templates",
      status: templates.approved > 0 ? "ok" : "warn",
      detail: `${templates.approved} approved of ${templates.total} total.`,
    })
  }

  const hasError = checks.some((c) => c.status === "error")
  const hasWarn = checks.some((c) => c.status === "warn")
  // A number whose token is readable and whose profile Meta will return is
  // "connected", but it is only "healthy" once every functional check passes.
  // When it is reachable but a functional check fails (e.g. Cloud API messaging
  // not registered, or webhook not subscribed) we report "degraded" — truthful,
  // and never a false green — while still keeping the workspace usable so the
  // admin can run coexistence onboarding.
  const overall: ConnectionHealth["overall"] = !phoneOk || !tokenReadable
    ? "down"
    : hasError || hasWarn
      ? "degraded"
      : "healthy"

  return {
    connected: phoneOk && tokenReadable,
    overall,
    integration: toPublicIntegration(integration as WhatsAppIntegrationRow),
    webhookUrl: getWebhookUrl(),
    checks,
    phone,
    webhook,
    templates,
    checkedAt,
  }
}
