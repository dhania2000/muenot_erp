import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureMessagesSchema } from "@/lib/messages-ensure"
import { audit, getParticipant, isConversationAdmin, MAX_MESSAGE_LEN, sanitizeBody } from "@/lib/messages-core"

async function loadMessage(mid: string) {
  return (await query<any[]>("SELECT * FROM messages WHERE id=? LIMIT 1", [mid]))[0] || null
}

/** PATCH /api/messages/item/[mid] — edit own message body (Phase 20). */
export async function PATCH(request: Request, { params }: { params: Promise<{ mid: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureMessagesSchema()

  const { mid } = await params
  const msg = await loadMessage(mid)
  if (!msg) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await getParticipant(msg.conversation_id, session.userId)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (msg.sender_id !== session.userId) return NextResponse.json({ error: "You can only edit your own messages" }, { status: 403 })
  if (msg.deleted_at) return NextResponse.json({ error: "Message deleted" }, { status: 400 })

  const body = await request.json().catch(() => ({}))
  const text = sanitizeBody(body.body)
  if (!text) return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 })
  if (text.length > MAX_MESSAGE_LEN) return NextResponse.json({ error: "Message too long" }, { status: 400 })

  await query("UPDATE messages SET body=?, edited_at=NOW() WHERE id=?", [text, mid])
  await audit("message_edited", session, { conversationId: msg.conversation_id, messageId: Number(mid) })
  return NextResponse.json({ success: true })
}

/** DELETE /api/messages/item/[mid] — soft-delete. Sender or a group admin. */
export async function DELETE(request: Request, { params }: { params: Promise<{ mid: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureMessagesSchema()

  const { mid } = await params
  const msg = await loadMessage(mid)
  if (!msg) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await getParticipant(msg.conversation_id, session.userId)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const isOwner = msg.sender_id === session.userId
  const canModerate = await isConversationAdmin(msg.conversation_id, session)
  if (!isOwner && !canModerate) return NextResponse.json({ error: "Not allowed" }, { status: 403 })

  await query("UPDATE messages SET deleted_at=NOW(), deleted_by=? WHERE id=?", [session.userId, mid])
  await audit("message_deleted", session, {
    conversationId: msg.conversation_id,
    messageId: Number(mid),
    detail: isOwner ? "self" : "moderated",
  })
  return NextResponse.json({ success: true })
}

/** POST /api/messages/item/[mid] — report a message for review (Phase 58). */
export async function POST(request: Request, { params }: { params: Promise<{ mid: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureMessagesSchema()

  const { mid } = await params
  const msg = await loadMessage(mid)
  if (!msg) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await getParticipant(msg.conversation_id, session.userId)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  await query(
    "INSERT INTO message_reports (message_id, conversation_id, reported_by, reason) VALUES (?,?,?,?)",
    [mid, msg.conversation_id, session.userId, String(body.reason || "").slice(0, 500)],
  )
  await audit("message_reported", session, { conversationId: msg.conversation_id, messageId: Number(mid) })
  return NextResponse.json({ success: true })
}
