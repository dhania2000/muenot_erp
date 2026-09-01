import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

const fields = ["employee_id", "leave_type_id", "year", "event_type", "days", "reference", "reason"] as const

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const rows = await query<any[]>(`SELECT h.*, e.employee_name FROM hr_leave_quota_history h JOIN hr_employees e ON e.employee_id = h.employee_id ORDER BY h.created_at DESC`)
  return NextResponse.json({ events: rows })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  const employeeId = Number(body.employee_id), leaveTypeId = Number(body.leave_type_id), year = Number(body.year), days = Number(body.days)
  if (![employeeId, leaveTypeId, year, days].every(Number.isFinite) || !body.event_type || !body.reason) return NextResponse.json({ error: "Employee, leave type, year, event type, days and reason are required" }, { status: 400 })
  await query(`INSERT INTO hr_leave_quota_history (employee_id, leave_type_id, year, event_type, days, reference, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [employeeId, leaveTypeId, year, String(body.event_type).slice(0, 40), days, body.reference || null, body.reason, (session as any).user?.id || null])
  return NextResponse.json({ ok: true }, { status: 201 })
}
