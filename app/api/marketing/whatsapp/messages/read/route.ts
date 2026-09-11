import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getWhatsAppIntegration, markWhatsAppMessageRead } from "@/lib/whatsapp"
import { getConversation, getUnreadInboundWamids, markConversationRead } from "@/lib/whatsapp-store"

/**
 * Marks a conversation's inbound messages as read: clears the ERP unread
 * counter and best-effort sends WhatsApp read receipts (blue ticks) for the
 * unread inbound messages. A failed receipt never blocks clearing the counter.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as { conversationId?: number }
  const conversationId = Number(body.conversationId)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "A conversationId is required." }, { status: 400 })
  }

  const conversation = await getConversation(conversationId)
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  }

  const integration = await getWhatsAppIntegration()
  if (integration) {
    const wamids = await getUnreadInboundWamids(conversationId)
    // Only the most recent inbound message needs a receipt; Meta marks the
    // whole thread up to it. Best-effort — ignore individual failures.
    if (wamids[0]) {
      await markWhatsAppMessageRead({ integration, wamid: wamids[0] }).catch(() => undefined)
    }
  }

  await markConversationRead(conversationId)
  return NextResponse.json({ ok: true })
}
