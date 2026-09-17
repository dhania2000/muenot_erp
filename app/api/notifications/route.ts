import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureNotificationsSchema } from "@/lib/notifications"

export const dynamic = "force-dynamic"

type NotificationRow = {
  id: number
  title: string
  body: string | null
  link: string | null
  module_key: string | null
  group_slug: string | null
  action: string
  actor_name: string | null
  is_read: number
  created_at: string
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ notifications: [], unread: 0 }, { status: 401 })

  try {
    await ensureNotificationsSchema()
    const notifications = await query<NotificationRow[]>(
      `SELECT id, title, body, link, module_key, group_slug, action, actor_name, is_read, created_at
         FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 40`,
      [session.userId],
    )
    const unreadRows = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0`,
      [session.userId],
    )
    return NextResponse.json({ notifications, unread: unreadRows[0]?.c ?? 0 })
  } catch (err) {
    console.error("[v0] notifications GET failed:", err)
    return NextResponse.json({ notifications: [], unread: 0 })
  }
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureNotificationsSchema()
    const body = await request.json().catch(() => ({}))
    const id = body?.id

    if (id) {
      await query(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [id, session.userId])
    } else {
      await query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [session.userId])
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[v0] notifications PATCH failed:", err)
    return NextResponse.json({ error: "Failed" }, { status: 500 })
  }
}
