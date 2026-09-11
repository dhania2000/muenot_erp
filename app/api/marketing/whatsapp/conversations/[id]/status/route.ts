import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  canAccessConversation,
  getConversation,
  inboxScopeFor,
  setConversationStatus,
} from "@/lib/whatsapp-store"
import { isWhatsAppStatus } from "@/lib/whatsapp-shared"

/** Updates a conversation's workflow status (open / pending / closed). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversationId = Number(id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as { status?: string }
  if (!isWhatsAppStatus(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 })
  }

  const conversation = await getConversation(conversationId)
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })

  const scope = inboxScopeFor(session.role, session.userId)
  if (!canAccessConversation(conversation, scope)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  await setConversationStatus(conversationId, body.status)
  const updated = await getConversation(conversationId)
  return NextResponse.json({ ok: true, conversation: updated })
}
