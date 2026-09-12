import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureLeadLifecycleSchema()
  const notifications = await query<any[]>(
    `SELECT * FROM sales_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`,
    [session.userId],
  )
  const [{ unread }] = await query<{ unread: number }[]>(
    `SELECT COUNT(*) AS unread FROM sales_notifications WHERE user_id = ? AND is_read = 0`,
    [session.userId],
  )
  return NextResponse.json({ notifications, unread: Number(unread) })
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  if (body.id) {
    await query(`UPDATE sales_notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [body.id, session.userId])
  } else {
    await query(`UPDATE sales_notifications SET is_read = 1 WHERE user_id = ?`, [session.userId])
  }
  return NextResponse.json({ success: true })
}
