import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureMessagesSchema } from "@/lib/messages-ensure"

/** GET /api/messages/notifications — the caller's message notification feed. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureMessagesSchema()

  const notifications = await query<any[]>(
    `SELECT n.*, c.type AS conversation_type, c.name AS group_name
       FROM message_notifications n
       LEFT JOIN conversations c ON c.id = n.conversation_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 40`,
    [session.userId],
  )
  const [{ unread }] = await query<{ unread: number }[]>(
    "SELECT COUNT(*) AS unread FROM message_notifications WHERE user_id=? AND is_read=0",
    [session.userId],
  )
  return NextResponse.json({ notifications, unread: Number(unread) })
}

/** PATCH /api/messages/notifications — mark one (body.id) or all as read. */
export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureMessagesSchema()

  const body = await request.json().catch(() => ({}))
  if (body.id) await query("UPDATE message_notifications SET is_read=1 WHERE id=? AND user_id=?", [body.id, session.userId])
  else await query("UPDATE message_notifications SET is_read=1 WHERE user_id=?", [session.userId])
  return NextResponse.json({ success: true })
}
