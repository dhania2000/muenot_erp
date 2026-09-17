import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureEventsAccessSchema, generateToken } from "@/lib/events-access"

async function auth(feature: "events.view" | "events.manage") {
  const session = await getSession()
  if (!session) return null
  if (!(await userHasFeature(session.userId, session.role, feature))) return null
  return session
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth("events.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEventsAccessSchema()

  const id = Number((await params).id)
  const q = request.nextUrl.searchParams.get("q")?.trim()
  const status = request.nextUrl.searchParams.get("status")?.trim()

  const where = ["p.event_id = ?"]
  const args: unknown[] = [id]
  if (q) {
    where.push("(p.employee_name LIKE ? OR p.employee_ref LIKE ? OR p.department LIKE ?)")
    args.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }
  if (status) {
    where.push("p.access_status = ?")
    args.push(status)
  }

  // Join live employee data so status changes reflect immediately in the roster.
  const rows = await query<any[]>(
    `SELECT p.*, e.employment_status AS live_status, e.photo_url
       FROM event_participants p
       LEFT JOIN hr_employees e ON e.id = p.employee_pk
      WHERE ${where.join(" AND ")}
      ORDER BY p.employee_name`,
    args,
  )
  return NextResponse.json({ participants: rows })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth("events.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEventsAccessSchema()

  const eventId = Number((await params).id)
  const body = await request.json()
  let pks: number[] = []

  if (body.all_active) {
    const emps = await query<any[]>("SELECT id FROM hr_employees WHERE employment_status = 'Active'")
    pks = emps.map((e) => Number(e.id))
  } else if (Array.isArray(body.employee_pks)) {
    pks = body.employee_pks.map((x: unknown) => Number(x)).filter(Boolean)
  }
  if (!pks.length) return NextResponse.json({ error: "Select at least one employee" }, { status: 400 })

  let added = 0
  for (const pk of pks) {
    const [emp] = await query<any[]>(
      "SELECT id, employee_id, employee_name, designation, department, employment_status FROM hr_employees WHERE id = ? LIMIT 1",
      [pk],
    )
    if (!emp) continue
    const res = await query<any>(
      `INSERT INTO event_participants
         (event_id, employee_pk, employee_ref, employee_name, designation, department, employment_status, token)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE employee_name = VALUES(employee_name), designation = VALUES(designation),
         department = VALUES(department), employment_status = VALUES(employment_status)`,
      [eventId, emp.id, emp.employee_id, emp.employee_name, emp.designation, emp.department, emp.employment_status, generateToken()],
    )
    if (res?.affectedRows === 1) added++
  }
  return NextResponse.json({ ok: true, added })
}

// Revoke, restore or regenerate a participant's QR token (Phases 45-47).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth("events.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEventsAccessSchema()

  const eventId = Number((await params).id)
  const body = await request.json()
  const participantId = Number(body.participant_id)
  const action = String(body.action || "")
  if (!participantId) return NextResponse.json({ error: "participant_id required" }, { status: 400 })

  if (action === "revoke") {
    await query(
      "UPDATE event_participants SET token_active = 0, access_status = 'revoked', revoked_reason = ? WHERE id = ? AND event_id = ?",
      [String(body.reason || "Revoked by admin").slice(0, 255), participantId, eventId],
    )
  } else if (action === "restore") {
    await query(
      "UPDATE event_participants SET token_active = 1, access_status = 'invited', revoked_reason = NULL WHERE id = ? AND event_id = ?",
      [participantId, eventId],
    )
  } else if (action === "regenerate") {
    await query(
      "UPDATE event_participants SET token = ?, token_active = 1 WHERE id = ? AND event_id = ?",
      [generateToken(), participantId, eventId],
    )
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth("events.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const eventId = Number((await params).id)
  const participantId = Number(request.nextUrl.searchParams.get("participant_id"))
  if (!participantId) return NextResponse.json({ error: "participant_id required" }, { status: 400 })
  await query("DELETE FROM event_access_logs WHERE participant_id = ?", [participantId])
  await query("DELETE FROM event_participants WHERE id = ? AND event_id = ?", [participantId, eventId])
  return NextResponse.json({ ok: true })
}
