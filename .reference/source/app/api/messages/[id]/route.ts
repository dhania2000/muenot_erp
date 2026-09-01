import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(); const { id } = await params
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.view"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const member = await query<any[]>("SELECT 1 FROM conversation_participants WHERE conversation_id=? AND user_id=?", [id, session.userId])
  if (!member.length) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const messages = await query<any[]>("SELECT m.id,m.body,m.created_at,u.name AS sender_name,m.sender_id FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.created_at ASC", [id])
  await query("UPDATE conversation_participants SET last_read_at=NOW() WHERE conversation_id=? AND user_id=?", [id, session.userId])
  return NextResponse.json({ messages })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(); const { id } = await params; const body = await request.json()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.send"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const member = await query<any[]>("SELECT 1 FROM conversation_participants WHERE conversation_id=? AND user_id=?", [id, session.userId])
  const text = String(body.body || "").trim(); if (!member.length || !text || text.length > 5000) return NextResponse.json({ error: "Invalid message" }, { status: 400 })
  await query("INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)", [id, session.userId, text])
  return NextResponse.json({ ok: true }, { status: 201 })
}
