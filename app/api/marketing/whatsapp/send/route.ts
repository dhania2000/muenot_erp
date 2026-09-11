import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getWhatsAppIntegration, sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp"
import {
  assignConversation,
  canAccessConversation,
  findOrCreateContact,
  findOrCreateConversation,
  getConversation,
  inboxScopeFor,
  recordOutboundMessage,
} from "@/lib/whatsapp-store"

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

function withinServiceWindow(lastCustomerMessageAt: string | null): boolean {
  if (!lastCustomerMessageAt) return false
  const t = new Date(lastCustomerMessageAt.replace(" ", "T") + "Z").getTime()
  if (!Number.isFinite(t)) return false
  return Date.now() - t < SERVICE_WINDOW_MS
}

/**
 * Sends a message from the connected WhatsApp Business number and records it in
 * the inbox so it appears alongside inbound messages.
 *
 * Free-form text only reaches a recipient inside the 24-hour customer service
 * window; outside of it Meta requires an approved template, so callers must
 * pass `mode: "template"` (defaulting to the built-in `hello_world`). When a
 * `conversationId` is supplied we enforce that window server-side and block a
 * free-text reply that Meta would reject anyway, with a clear message.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    return NextResponse.json({ error: "No WhatsApp account is connected yet." }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    to?: string
    message?: string
    mode?: "text" | "template"
    templateName?: string
    languageCode?: string
    conversationId?: number
  }

  const mode = body.mode === "template" ? "template" : "text"

  // Resolve the recipient. A conversationId takes precedence so replies always
  // target the right contact even if the client omits `to`.
  let to = body.to?.trim().replace(/[^\d]/g, "") || ""
  let conversationId = Number(body.conversationId) || null

  if (conversationId) {
    const conversation = await getConversation(conversationId)
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
    }

    // Shared-inbox RBAC: an agent may only reply to a thread that is theirs or
    // still unassigned. Admins may reply to anything.
    const scope = inboxScopeFor(session.role, session.userId)
    if (!canAccessConversation(conversation, scope)) {
      return NextResponse.json(
        { error: "This conversation is assigned to another agent." },
        { status: 403 },
      )
    }

    // Replying to an unassigned thread claims it for the sender so the rest of
    // the team can see who is handling the customer.
    if (conversation.assignedAgentId === null) {
      try {
        await assignConversation({
          conversationId,
          agentId: session.userId,
          team: conversation.assignedTeam,
          byUserId: session.userId,
          note: "Auto-claimed on reply",
        })
      } catch (err) {
        console.error("[v0] Failed to auto-claim conversation on reply:", (err as Error).message)
      }
    }

    to = conversation.phoneNumber

    // Enforce the 24-hour window for free-form text replies.
    if (mode === "text" && !withinServiceWindow(conversation.lastCustomerMessageAt)) {
      return NextResponse.json(
        {
          error:
            "This conversation is outside the 24-hour reply window. Send an approved template message to re-engage this contact.",
          code: "outside_service_window",
        },
        { status: 409 },
      )
    }
  }

  if (!to) {
    return NextResponse.json(
      { error: "A recipient phone number (with country code) is required." },
      { status: 400 },
    )
  }

  if (mode === "text" && !body.message?.trim()) {
    return NextResponse.json({ error: "Message body is required." }, { status: 400 })
  }

  const messageBody = body.message?.trim() || ""
  const templateName = body.templateName?.trim() || "hello_world"

  const result =
    mode === "template"
      ? await sendWhatsAppTemplate({
          integration,
          to,
          templateName,
          languageCode: body.languageCode?.trim() || "en_US",
        })
      : await sendWhatsAppText({ integration, to, body: messageBody })

  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Failed to send message." }, { status: 502 })
  }

  // Record the outbound message so it shows in the inbox. If no conversation
  // was supplied (e.g. an ad-hoc test send), open/find one for this recipient.
  try {
    if (!conversationId) {
      const contact = await findOrCreateContact({ phone: to })
      const conversation = await findOrCreateConversation({
        contactId: contact.id,
        phoneNumberId: integration.phone_number_id,
        wabaId: integration.waba_id,
      })
      conversationId = conversation.id
    }
    await recordOutboundMessage({
      conversationId,
      wamid: result.messageId ?? null,
      messageType: mode === "template" ? "template" : "text",
      body: mode === "template" ? `[template] ${templateName}` : messageBody,
      senderPhone: integration.display_phone_number
        ? integration.display_phone_number.replace(/[^\d]/g, "")
        : null,
      recipientPhone: to,
      status: "sent",
      sentByUserId: session.userId,
    })
  } catch (err) {
    // Sending succeeded; a logging failure must not fail the request.
    console.error("[v0] Failed to record outbound WhatsApp message:", (err as Error).message)
  }

  return NextResponse.json({ ok: true, messageId: result.messageId, conversationId })
}
