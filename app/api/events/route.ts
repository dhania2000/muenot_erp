import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

const attendeeTypes = ["all_employees", "all_clients", "specific"] as const
type AttendeeType = (typeof attendeeTypes)[number]
const statuses = ["pending", "completed"] as const
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
  const status = statuses.includes(body.status) ? body.status : "pending"
  return { name, description, location, labelColor, startAt, endAt, repeatEnabled, repeatCycle, repeatEvery, repeatEndsOn, hostName, attendeeType, attendees, status }
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "events.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const where: string[] = []
  const params: unknown[] = []

  const search = sp.get("q")?.trim()
  if (search) {
    where.push("(name LIKE ? OR location LIKE ? OR host_name LIKE ?)")
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  if (sp.get("status") && statuses.includes(sp.get("status") as any)) {
    where.push("status = ?")
    params.push(sp.get("status"))
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
  const events = rows.map((e) => ({ ...e, attendees: e.attendees ? JSON.parse(e.attendees) : [] }))

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

  const b = normalizeBody(await request.json())
  if (!b.name || !b.startAt || !b.endAt)
    return NextResponse.json({ error: "Event name, start and end date/time are required" }, { status: 400 })

  await query(
    "INSERT INTO hr_events (name, label_color, location, description, start_at, end_at, repeat_enabled, repeat_cycle, repeat_every, repeat_ends_on, host_name, attendee_type, attendees, status, created_by, created_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [b.name, b.labelColor, b.location, b.description, b.startAt, b.endAt, b.repeatEnabled, b.repeatCycle, b.repeatEvery, b.repeatEndsOn, b.hostName, b.attendeeType, b.attendees, b.status, session.userId, session.name],
  )
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const id = Number(body.id)
  const b = normalizeBody(body)
  if (!id || !b.name || !b.startAt || !b.endAt)
    return NextResponse.json({ error: "Event, name, start and end date/time are required" }, { status: 400 })

  await query(
    "UPDATE hr_events SET name=?, label_color=?, location=?, description=?, start_at=?, end_at=?, repeat_enabled=?, repeat_cycle=?, repeat_every=?, repeat_ends_on=?, host_name=?, attendee_type=?, attendees=?, status=? WHERE id=?",
    [b.name, b.labelColor, b.location, b.description, b.startAt, b.endAt, b.repeatEnabled, b.repeatCycle, b.repeatEvery, b.repeatEndsOn, b.hostName, b.attendeeType, b.attendees, b.status, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = Number(request.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Event id required" }, { status: 400 })
  await query("DELETE FROM hr_events WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
