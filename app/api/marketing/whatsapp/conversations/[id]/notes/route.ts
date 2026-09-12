import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getConversation } from "@/lib/whatsapp-store"
import { addInternalNote, listInternalNotes } from "@/lib/whatsapp-platform"

/**
 * Internal notes on a conversation — visible only to ERP users, never sent to
 * the customer. Any authenticated agent may read and add notes.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversationId = Number(id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 })
  }

  const notes = await listInternalNotes(conversationId)
  return NextResponse.json({ notes })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversationId = Number(id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 })
  }

  const conversation = await getConversation(conversationId)
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as { note?: string }
  const note = (body.note ?? "").trim()
  if (!note) return NextResponse.json({ error: "Note text is required" }, { status: 400 })

  await addInternalNote({ conversationId, userId: session.userId, note: note.slice(0, 2000) })
  const notes = await listInternalNotes(conversationId)
  return NextResponse.json({ ok: true, notes }, { status: 201 })
}
