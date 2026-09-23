import { NextResponse } from "next/server"
import {
  getWhatsAppIntegrationByPhoneNumberId,
  getWebhookVerifyToken,
  verifyWebhookSignature,
  type WhatsAppIntegrationRow,
} from "@/lib/whatsapp"
import { runForTenant } from "@/lib/tenant-scope"
import {
  findOrCreateContact,
  findOrCreateConversation,
  recordInboundMessage,
  updateMessageStatusByWamid,
  logWebhookEvent,
  getInboundContext,
  normalizePhone,
  type MessageStatus,
} from "@/lib/whatsapp-store"
import { routeConversation } from "@/lib/whatsapp-routing"
import { enqueueWhatsAppMessageNotifications } from "@/lib/whatsapp-push-notifications"
import { runInboundAutomations } from "@/lib/whatsapp-automations"
import { applyCampaignStatusByWamid, markCampaignReplied } from "@/lib/whatsapp-campaigns"
import { monitorLogger } from "@/lib/system-monitoring"

/**
 * WhatsApp Cloud API webhook.
 *
 * GET  — Meta's verification handshake (hub.mode / hub.verify_token / hub.challenge).
 * POST — inbound messages + outbound status updates. The body is HMAC-signed by
 *        Meta with the app secret (X-Hub-Signature-256); we reject anything that
 *        does not verify. Processing is idempotent (unique wamid) so Meta's
 *        retries never create duplicates, and we always answer 200 quickly once
 *        the signature checks out so Meta does not hammer us with retries.
 *
 * This endpoint is intentionally NOT behind the ERP session — it is called by
 * Meta's servers. Its authenticity comes from the signature check instead.
 */

/* ----------------------------- GET (verify) ----------------------------- */

export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")

  const expected = getWebhookVerifyToken()

  if (mode === "subscribe" && expected && token === expected) {
    // Meta expects the raw challenge echoed back as text/plain with 200.
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  // Never reveal whether the token was configured or simply mismatched.
  return new NextResponse("Forbidden", { status: 403 })
}

/* ----------------------------- POST (events) ---------------------------- */

type MetaMessage = {
  from?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  image?: MetaMedia
  document?: MetaMedia & { filename?: string }
  video?: MetaMedia
  audio?: MetaMedia
  sticker?: MetaMedia
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
  contacts?: unknown[]
  button?: { text?: string; payload?: string }
  interactive?: {
    button_reply?: { title?: string }
    list_reply?: { title?: string }
  }
}

type MetaMedia = { id?: string; mime_type?: string; caption?: string; sha256?: string }

type MetaStatus = {
  id?: string
  status?: string
  timestamp?: string
  recipient_id?: string
  errors?: { code?: number; title?: string; message?: string }[]
}

type MetaValue = {
  messaging_product?: string
  metadata?: { display_phone_number?: string; phone_number_id?: string }
  contacts?: { profile?: { name?: string }; wa_id?: string }[]
  messages?: MetaMessage[]
  statuses?: MetaStatus[]
}

type MetaWebhookBody = {
  object?: string
  entry?: { id?: string; changes?: { field?: string; value?: MetaValue }[] }[]
}

function tsToDate(ts: string | undefined | null): Date {
  const seconds = Number(ts)
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000)
  return new Date()
}

/** Pulls a normalized (type, body, media) out of an inbound Meta message. */
function extractInbound(m: MetaMessage): {
  type: string
  body: string | null
  mediaId: string | null
  mediaMime: string | null
  mediaFilename: string | null
} {
  const type = m.type || "unknown"
  switch (type) {
    case "text":
      return { type, body: m.text?.body ?? "", mediaId: null, mediaMime: null, mediaFilename: null }
    case "image":
    case "video":
    case "audio":
    case "sticker": {
      const media = (m as Record<string, MetaMedia>)[type]
      return {
        type,
        body: media?.caption ?? null,
        mediaId: media?.id ?? null,
        mediaMime: media?.mime_type ?? null,
        mediaFilename: null,
      }
    }
    case "document":
      return {
        type,
        body: m.document?.caption ?? null,
        mediaId: m.document?.id ?? null,
        mediaMime: m.document?.mime_type ?? null,
        mediaFilename: m.document?.filename ?? null,
      }
    case "location": {
      const loc = m.location
      const label = loc?.name || loc?.address || (loc ? `${loc.latitude}, ${loc.longitude}` : null)
      return { type, body: label, mediaId: null, mediaMime: null, mediaFilename: null }
    }
    case "button":
      return { type, body: m.button?.text ?? null, mediaId: null, mediaMime: null, mediaFilename: null }
    case "interactive":
      return {
        type,
        body: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || null,
        mediaId: null,
        mediaMime: null,
        mediaFilename: null,
      }
    default:
      // Unsupported optional type — stored as metadata only, never crashes.
      return { type, body: null, mediaId: null, mediaMime: null, mediaFilename: null }
  }
}

const KNOWN_STATUSES: MessageStatus[] = ["sent", "delivered", "read", "failed"]

export async function POST(request: Request) {
  // Raw body is required for an exact signature match.
  const rawBody = await request.text()
  const signature = request.headers.get("x-hub-signature-256")

  if (!verifyWebhookSignature(rawBody, signature)) {
    monitorLogger.warning({ service: "webhook", component: "whatsapp", operation: "signature_verification", errorCode: "INVALID_WEBHOOK_SIGNATURE", message: "WhatsApp webhook signature rejected", route: "/api/marketing/whatsapp/webhook", method: "POST", httpStatus: 403, requestId: request.headers.get("x-request-id") || undefined })
    return new NextResponse("Invalid signature", { status: 403 })
  }

  let body: MetaWebhookBody
  try {
    body = JSON.parse(rawBody) as MetaWebhookBody
  } catch {
    // Acknowledge malformed bodies so Meta does not retry endlessly.
    return NextResponse.json({ ok: true })
  }

  if (body.object !== "whatsapp_business_account") {
    return NextResponse.json({ ok: true })
  }

  // Process defensively: a single bad message must never 500 the whole batch.
  try {
    await processWebhook(body)
  } catch (err) {
    console.error("[v0] WhatsApp webhook processing error")
    monitorLogger.error({ service: "webhook", component: "whatsapp", operation: "processing", errorCode: "WHATSAPP_WEBHOOK_PROCESSING_FAILED", message: "WhatsApp webhook processing failed", route: "/api/marketing/whatsapp/webhook", method: "POST", requestId: request.headers.get("x-request-id") || undefined })
    // Still 200 — we have the raw event and Meta retries add no value here.
  }

  return NextResponse.json({ ok: true })
}

async function processWebhook(body: MetaWebhookBody) {
  for (const entry of body.entry ?? []) {
    const wabaId = entry.id ?? null
    for (const change of entry.changes ?? []) {
      // `messages` carries inbound messages + outbound status updates.
      // Anything else is ignored.
      if (change.field !== "messages") continue
      const value = change.value
      if (!value) continue

      const phoneNumberId = value.metadata?.phone_number_id ?? null

      // The webhook has NO ERP session, so the incoming phone_number_id is the
      // only trustworthy way to discover which tenant owns this delivery.
      // Resolve it to a tenant-owned integration — NEVER guess a tenant and
      // never fall back to the env/global credential for an unknown number.
      const integration = phoneNumberId
        ? await getWhatsAppIntegrationByPhoneNumberId(phoneNumberId)
        : null

      if (!integration || integration.tenant_id == null || integration.id === 0 || (wabaId && integration.waba_id !== wabaId)) {
        // Unknown / unmapped / env-only number: do not attribute it to any
        // tenant. Log it without tenant context and skip. We still answer 200
        // upstream so Meta stops retrying a structurally valid but unowned event.
        await logWebhookEvent({
          eventType: `${change.field}.unmapped`,
          phoneNumberId,
          dedupKey: `unmapped:${phoneNumberId ?? "none"}:${Date.now()}`,
          processingStatus: "skipped",
        })
        continue
      }

      // Everything below runs inside the OWNING tenant's context so every
      // read/write is scoped to exactly this tenant.
      await runForTenant({ tenantId: integration.tenant_id }, () =>
        processChange({ value, wabaId, phoneNumberId, integration }),
      )
    }
  }
}

/** Processes one Meta change payload inside its owning tenant's context. */
async function processChange(input: {
  value: MetaValue
  wabaId: string | null
  phoneNumberId: string | null
  integration: WhatsAppIntegrationRow
}) {
  const { value, wabaId, phoneNumberId, integration } = input
  const integrationId = integration.id

  const nameByWaId = new Map<string, string>()
  for (const c of value.contacts ?? []) {
    if (c.wa_id && c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name)
  }

  /* ----- inbound messages ----- */
  for (const m of value.messages ?? []) {
    if (!m.id || !m.from) continue
    const dedupKey = `msg:${m.id}`
    try {
      const fromPhone = normalizePhone(m.from)
      const contact = await findOrCreateContact({
        phone: fromPhone,
        profileName: nameByWaId.get(m.from) ?? null,
        waContactId: m.from,
        integrationId,
      })
      const conversation = await findOrCreateConversation({
        contactId: contact.id,
        phoneNumberId: phoneNumberId ?? integration.phone_number_id,
        wabaId,
        integrationId,
      })
      const parsed = extractInbound(m)
      const created = await recordInboundMessage({
        conversationId: conversation.id,
        wamid: m.id,
        messageType: parsed.type,
        body: parsed.body,
        mediaId: parsed.mediaId,
        mediaMimeType: parsed.mediaMime,
        mediaFilename: parsed.mediaFilename,
        senderPhone: fromPhone,
        recipientPhone: value.metadata?.display_phone_number
          ? normalizePhone(value.metadata.display_phone_number)
          : integration.display_phone_number
            ? normalizePhone(integration.display_phone_number)
            : "",
        metaTimestamp: tsToDate(m.timestamp),
        integrationId,
      })
      await logWebhookEvent({
        eventType: `message.${parsed.type}`,
        wamid: m.id,
        phoneNumberId,
        integrationId,
        dedupKey,
        processingStatus: created ? "processed" : "skipped",
      })

      // Only run routing/automations for genuinely new (non-duplicate)
      // inbound messages. All of it is best-effort: a failure here must
      // never turn a delivered customer message into a webhook error.
      if (created) {
        const messageText = parsed.body ?? ""
        // A customer reply closes the loop on any campaign they were sent.
        // Awaited (not fire-and-forget) so it stays inside this tenant's context.
        try {
          await markCampaignReplied(fromPhone)
        } catch (err) {
          console.error("[v0] campaign reply tracking failed:", (err as Error).message)
        }
        try {
          const ctx = await getInboundContext({
            conversationId: conversation.id,
            contactId: contact.id,
          })
          await routeConversation({ conversationId: conversation.id, messageText })
          await runInboundAutomations({
            conversationId: conversation.id,
            phone: fromPhone,
            messageText,
            isNewContact: ctx.isNewContact,
            isNewConversation: ctx.isNewConversation,
            isAssigned: ctx.assignedAgentId != null,
          })
        } catch (err) {
          console.error("[v0] inbound routing/automation failed:", (err as Error).message)
        }
        try {
          const deliveryContext = await getInboundContext({ conversationId: conversation.id, contactId: contact.id })
          const queued = await enqueueWhatsAppMessageNotifications({
            tenantId: Number(integration.tenant_id), wamid: m.id, conversationId: conversation.id,
            assignedAgentId: deliveryContext.assignedAgentId, contactName: contact.profile_name,
            preview: parsed.body, timestamp: tsToDate(m.timestamp)?.toISOString() ?? null,
          })
          if (queued.recipients === 0) console.info("[mobile-push] whatsapp_event_has_no_recipients", { tenantId:Number(integration.tenant_id),conversationId:conversation.id })
        } catch {
          // Notifications are best-effort; never fail the accepted WhatsApp webhook.
          console.warn("[mobile-push] whatsapp_event_queue_failed", { tenantId:Number(integration.tenant_id),conversationId:conversation.id })
        }
      }
    } catch (err) {
      await logWebhookEvent({
        eventType: "message.error",
        wamid: m.id,
        phoneNumberId,
        integrationId,
        dedupKey,
        processingStatus: "error",
        error: (err as Error).message,
      })
    }
  }

  /* ----- outbound status updates ----- */
  for (const s of value.statuses ?? []) {
    if (!s.id || !s.status) continue
    const status = s.status as MessageStatus
    if (!KNOWN_STATUSES.includes(status)) continue
    const dedupKey = `status:${s.id}:${status}`
    try {
      const firstError = s.errors?.[0]
      const updated = await updateMessageStatusByWamid({
        wamid: s.id,
        status,
        timestamp: tsToDate(s.timestamp),
        errorCode: firstError?.code != null ? String(firstError.code) : null,
        errorMessage: firstError?.message || firstError?.title || null,
      })
      // Mirror delivery progress onto any campaign recipient row that
      // shares this wamid so campaign analytics stay accurate. Awaited so it
      // runs inside this tenant's context.
      if (status === "delivered" || status === "read" || status === "failed") {
        try {
          await applyCampaignStatusByWamid(s.id, status)
        } catch (err) {
          console.error("[v0] campaign status tracking failed:", (err as Error).message)
        }
      }
      await logWebhookEvent({
        eventType: `status.${status}`,
        wamid: s.id,
        phoneNumberId,
        integrationId,
        dedupKey,
        processingStatus: updated ? "processed" : "skipped",
      })
    } catch (err) {
      await logWebhookEvent({
        eventType: "status.error",
        wamid: s.id,
        phoneNumberId,
        integrationId,
        dedupKey,
        processingStatus: "error",
        error: (err as Error).message,
      })
    }
  }
}
