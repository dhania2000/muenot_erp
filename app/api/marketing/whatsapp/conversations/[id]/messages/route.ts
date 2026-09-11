import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getConversation, listMessages } from "@/lib/whatsapp-store"

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

function withinServiceWindow(lastCustomerMessageAt: string | null): boolean {
  if (!lastCustomerMessageAt) return false
  const t = new Date(lastCustomerMessageAt.replace(" ", "T") + "Z").getTime()
  if (!Number.isFinite(t)) return false
  return Date.now() - t < SERVICE_WINDOW_MS
}

/** Returns a conversation's detail (incl. linked CRM lead) and its messages. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversationId = Number(id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 })
  }

  const conversation = await getConversation(conversationId)
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  }

  const messages = await listMessages(conversationId)

  return NextResponse.json({
    conversation: {
      ...conversation,
      withinServiceWindow: withinServiceWindow(conversation.lastCustomerMessageAt),
    },
    messages: messages.map((m) => ({
      id: m.id,
      wamid: m.wamid,
      direction: m.direction,
      messageType: m.message_type,
      body: m.message_body,
      mediaId: m.media_id,
      mediaMimeType: m.media_mime_type,
      mediaFilename: m.media_filename,
      status: m.status,
      errorCode: m.error_code,
      errorMessage: m.error_message,
      metaTimestamp: m.meta_timestamp,
      sentAt: m.sent_at,
      deliveredAt: m.delivered_at,
      readAt: m.read_at,
      createdAt: m.created_at,
    })),
  })
}
