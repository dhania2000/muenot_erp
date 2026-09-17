import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureEventsAccessSchema, EVENT_STATUSES, generateToken, normalizeEventStatus } from "@/lib/events-access"

const attendeeTypes = ["all_employees", "all_clients", "specific"] as const
type AttendeeType = (typeof attendeeTypes)[number]
const cycles = ["day", "week", "month", "year"] as const

async function loadEmployees(): Promise<string[]> {
  try {
    const rows = await query<any[]>(
      "SELECT employee_name FROM hr_employees WHERE employee_name IS NOT NULL AND employee_name <> '' ORDER BY employee_name",
    )
    return rows.map((r) => r.employee_name)
  } catch {
    return []
  }
}

function normalizeBody(body: any) {
  const name = String(body.name || "").trim()
  const description = body.description != null ? String(body.description).trim() : null
  const location = body.location != null ? String(body.location).trim() : null
  const labelColor = String(body.label_color || "#4f46e5").slice(0, 20)
  const startAt = String(body.start_at || "").replace("T", " ").slice(0, 19)
  const endAt = String(body.end_at || "").replace("T", " ").slice(0, 19)
  const repeatEnabled = body.repeat_enabled ? 1 : 0
  const repeatCycle = cycles.includes(body.repeat_cycle) ? body.repeat_cycle : "week"
  const repeatEvery = Math.max(1, Number(body.repeat_every) || 1)
  const repeatEndsOn = repeatEnabled && body.repeat_ends_on ? String(body.repeat_ends_on).slice(0, 10) : null
  const hostName = body.host_name ? String(body.host_name).trim() : null
  const attendeeType: AttendeeType = attendeeTypes.includes(body.attendee_type) ? body.attendee_type : "all_employees"
  const attendees =
    attendeeType === "specific" && Array.isArray(body.attendees)
      ? JSON.stringify(body.attendees.map((a: unknown) => String(a)))
      : null
  const status = normalizeEventStatus(body.status)
  const capacity = body.capacity != null && body.capacity !== "" ? Math.max(0, Number(body.capacity) || 0) : null
  const instructions = body.instructions != null ? String(body.instructions).trim() : null
  const contactPerson = body.contact_person != null ? String(body.contact_person).trim() : null
  const meetingDetails = body.meeting_details != null ? String(body.meeting_details).trim() : null
  const accessBefore = Math.max(0, Number(body.access_before_minutes ?? 30) || 0)
  const accessAfter = Math.max(0, Number(body.access_after_minutes ?? 0) || 0)
  const allowDob = body.allow_dob ? 1 : 0
  return {
    name, description, location, labelColor, startAt, endAt, repeatEnabled, repeatCycle, repeatEvery,
    repeatEndsOn, hostName, attendeeType, attendees, status, capacity, instructions, contactPerson,
    meetingDetails, accessBefore, accessAfter, allowDob,
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "events.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEventsAccessSchema()

  const sp = request.nextUrl.searchParams
  const where: string[] = []
  const params: unknown[] = []

  const search = sp.get("q")?.trim()
  if (search) {
    where.push("(name LIKE ? OR location LIKE ? OR host_name LIKE ? OR event_ref LIKE ?)")
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`)
  }
  const statusFilter = sp.get("status")
  if (statusFilter && (EVENT_STATUSES as readonly string[]).includes(statusFilter)) {
    if (statusFilter === "scheduled") where.push("(status = 'scheduled' OR status = 'pending')")
    else where.push("status = ?")
    if (statusFilter !== "scheduled") params.push(statusFilter)
  }
  if (sp.get("from")) {
    where.push("start_at >= ?")
    params.push(`${sp.get("from")} 00:00:00`)
  }
  if (sp.get("to_date")) {
    where.push("start_at <= ?")
    params.push(`${sp.get("to_date")} 23:59:59`)
  }

  const rows = await query<any[]>(
    "SELECT * FROM hr_events" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY start_at DESC",
    params as any[],
  )

  // Participant tallies per event (Phase 26/57), sourced from real records.
  const counts = await query<any[]>(
    `SELECT event_id,
            COUNT(*) AS invited,
            SUM(access_status = 'checked_in') AS checked_in,
            SUM(access_status = 'checked_out') AS checked_out,
            SUM(access_status IN ('revoked','denied')) AS denied
       FROM event_participants GROUP BY event_id`,
  )
  const countMap = new Map(counts.map((c) => [Number(c.event_id), c]))

  const events = rows.map((e) => {
    const c = countMap.get(Number(e.id))
    return {
      ...e,
      status: normalizeEventStatus(e.status),
      attendees: e.attendees ? JSON.parse(e.attendees) : [],
      participant_count: c ? Number(c.invited) : 0,
      checked_in_count: c ? Number(c.checked_in) : 0,
      checked_out_count: c ? Number(c.checked_out) : 0,
      denied_count: c ? Number(c.denied) : 0,
    }
  })

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "events.manage"))
  return NextResponse.json({ events, employees: await loadEmployees(), canManage })
}

async function requireManage() {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "events.manage"))) return null
  return session
}

export async function POST(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEventsAccessSchema()

  const b = normalizeBody(await request.json())
  if (!b.name || !b.startAt || !b.endAt)
    return NextResponse.json({ error: "Event name, start and end date/time are required" }, { status: 400 })

  const res = await query<any>(
    `INSERT INTO hr_events
       (name, label_color, location, description, start_at, end_at, repeat_enabled, repeat_cycle, repeat_every,
        repeat_ends_on, host_name, attendee_type, attendees, status, capacity, instructions, contact_person,
        meeting_details, access_before_minutes, access_after_minutes, allow_dob, event_token, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.name, b.labelColor, b.location, b.description, b.startAt, b.endAt, b.repeatEnabled, b.repeatCycle, b.repeatEvery,
     b.repeatEndsOn, b.hostName, b.attendeeType, b.attendees, b.status, b.capacity, b.instructions, b.contactPerson,
     b.meetingDetails, b.accessBefore, b.accessAfter, b.allowDob, generateToken(), session.userId, session.name],
  )
  const id = Number(res?.insertId || 0)
  if (id) await query("UPDATE hr_events SET event_ref = ? WHERE id = ?", [`EVT-${String(id).padStart(4, "0")}`, id])
  return NextResponse.json({ ok: true, id }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEventsAccessSchema()

  const body = await request.json()
  const id = Number(body.id)
  const b = normalizeBody(body)
  if (!id || !b.name || !b.startAt || !b.endAt)
    return NextResponse.json({ error: "Event, name, start and end date/time are required" }, { status: 400 })

  await query(
    `UPDATE hr_events SET name=?, label_color=?, location=?, description=?, start_at=?, end_at=?, repeat_enabled=?,
       repeat_cycle=?, repeat_every=?, repeat_ends_on=?, host_name=?, attendee_type=?, attendees=?, status=?,
       capacity=?, instructions=?, contact_person=?, meeting_details=?, access_before_minutes=?, access_after_minutes=?,
       allow_dob=?, updated_at=NOW() WHERE id=?`,
    [b.name, b.labelColor, b.location, b.description, b.startAt, b.endAt, b.repeatEnabled, b.repeatCycle, b.repeatEvery,
     b.repeatEndsOn, b.hostName, b.attendeeType, b.attendees, b.status, b.capacity, b.instructions, b.contactPerson,
     b.meetingDetails, b.accessBefore, b.accessAfter, b.allowDob, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = Number(request.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Event id required" }, { status: 400 })
  await query("DELETE FROM event_access_logs WHERE event_id = ?", [id])
  await query("DELETE FROM event_participants WHERE event_id = ?", [id])
  await query("DELETE FROM hr_events WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
