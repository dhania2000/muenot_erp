import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureEventsAccessSchema, normalizeEventStatus } from "@/lib/events-access"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "events.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEventsAccessSchema()
  const id = Number((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid event" }, { status: 400 })

  const rows = await query<any[]>("SELECT * FROM hr_events WHERE id = ? LIMIT 1", [id])
  const event = rows[0]
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [tally] = await query<any[]>(
    `SELECT COUNT(*) AS invited,
            SUM(access_status = 'checked_in') AS checked_in,
            SUM(access_status = 'checked_out') AS checked_out,
            SUM(access_status IN ('revoked','denied')) AS denied,
            SUM(access_status = 'invited') AS pending
       FROM event_participants WHERE event_id = ?`,
    [id],
  )

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "events.manage"))

  return NextResponse.json({
    event: {
      ...event,
      status: normalizeEventStatus(event.status),
      attendees: event.attendees ? JSON.parse(event.attendees) : [],
    },
    stats: {
      invited: Number(tally?.invited || 0),
      checked_in: Number(tally?.checked_in || 0),
      checked_out: Number(tally?.checked_out || 0),
      denied: Number(tally?.denied || 0),
      pending: Number(tally?.pending || 0),
    },
    canManage,
  })
}
