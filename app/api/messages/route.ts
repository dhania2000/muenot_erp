import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

export async function GET() {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.view"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const rows = await query<any[]>(`SELECT c.id, c.subject, c.updated_at, m.body AS last_message, u.name AS last_sender,
    (SELECT COUNT(*) FROM messages mx JOIN conversation_participants px ON px.conversation_id=mx.conversation_id WHERE mx.conversation_id=c.id AND mx.sender_id<>? AND (px.last_read_at IS NULL OR mx.created_at>px.last_read_at) AND px.user_id=?) unread
    FROM conversations c JOIN conversation_participants p ON p.conversation_id=c.id LEFT JOIN messages m ON m.id=(SELECT MAX(id) FROM messages WHERE conversation_id=c.id) LEFT JOIN users u ON u.id=m.sender_id WHERE p.user_id=? ORDER BY c.updated_at DESC`, [session.userId, session.userId, session.userId])
  return NextResponse.json({ conversations: rows })
}

export async function POST(request: Request) {
  const session = await getSession(); const body = await request.json()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.send"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const recipientId = Number(body.recipientId); const text = String(body.body || "").trim()
  if (!recipientId || !text || text.length > 5000) return NextResponse.json({ error: "Recipient and message are required" }, { status: 400 })
  const recipient = (await query<any[]>("SELECT id, role FROM users WHERE id=? AND status='active' LIMIT 1", [recipientId]))[0]
  if (!recipient) return NextResponse.json({ error: "Recipient unavailable" }, { status: 404 })
  if (session.role === "employee") {
    const permission = (await query<any[]>("SELECT * FROM message_permissions WHERE employee_id=? LIMIT 1", [session.userId]))[0] || { can_message_employees: true, can_message_admins: true, can_message_management: true }
    if ((recipient.role === "employee" && !permission.can_message_employees) || (recipient.role === "admin" && !permission.can_message_admins)) return NextResponse.json({ error: "Messaging permission denied" }, { status: 403 })
  }
  await query("INSERT INTO conversations (subject,created_by) VALUES (?,?)", [body.subject || null, session.userId])
  const conversation = (await query<any[]>("SELECT LAST_INSERT_ID() id"))[0]
  await query("INSERT INTO conversation_participants (conversation_id,user_id) VALUES (?,?),(?,?)", [conversation.id, session.userId, conversation.id, recipientId])
  await query("INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)", [conversation.id, session.userId, text])
  return NextResponse.json({ id: conversation.id }, { status: 201 })
}
