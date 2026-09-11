import { NextResponse } from "next/server"
import {
  getWhatsAppIntegration,
  getWebhookVerifyToken,
  verifyWebhookSignature,
} from "@/lib/whatsapp"
import {
  findOrCreateContact,
  findOrCreateConversation,
  recordInboundMessage,
  updateMessageStatusByWamid,
  logWebhookEvent,
  normalizePhone,
  type MessageStatus,
} from "@/lib/whatsapp-store"

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
    console.error("[v0] WhatsApp webhook processing error:", (err as Error).message)
    // Still 200 — we have the raw event and Meta retries add no value here.
  }

  return NextResponse.json({ ok: true })
}

async function processWebhook(body: MetaWebhookBody) {
  const integration = await getWhatsAppIntegration()

  for (const entry of body.entry ?? []) {
    const wabaId = entry.id ?? null
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue
      const value = change.value
      if (!value) continue

      const phoneNumberId = value.metadata?.phone_number_id ?? null

      // Confirm the event targets the number we actually have connected.
      if (integration && phoneNumberId && phoneNumberId !== integration.phone_number_id) {
        await logWebhookEvent({
          eventType: "messages.foreign",
          phoneNumberId,
          dedupKey: `foreign:${phoneNumberId}:${Date.now()}`,
          processingStatus: "skipped",
        })
        continue
      }

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
          })
          const conversation = await findOrCreateConversation({
            contactId: contact.id,
            phoneNumberId: phoneNumberId ?? integration?.phone_number_id ?? "",
            wabaId,
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
              : integration?.display_phone_number
                ? normalizePhone(integration.display_phone_number)
                : "",
            metaTimestamp: tsToDate(m.timestamp),
          })
          await logWebhookEvent({
            eventType: `message.${parsed.type}`,
            wamid: m.id,
            phoneNumberId,
            dedupKey,
            processingStatus: created ? "processed" : "skipped",
          })
        } catch (err) {
          await logWebhookEvent({
            eventType: "message.error",
            wamid: m.id,
            phoneNumberId,
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
          await logWebhookEvent({
            eventType: `status.${status}`,
            wamid: s.id,
            phoneNumberId,
            dedupKey,
            processingStatus: updated ? "processed" : "skipped",
          })
        } catch (err) {
          await logWebhookEvent({
            eventType: "status.error",
            wamid: s.id,
            phoneNumberId,
            dedupKey,
            processingStatus: "error",
            error: (err as Error).message,
          })
        }
      }
    }
  }
}
