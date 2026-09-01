import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const requests = await query<any[]>("SELECT * FROM hr_attendance_regularisation ORDER BY requested_at DESC")
  return NextResponse.json({ requests })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await request.json()
    const employeeId = Number(body.employee_id)
    const workDate = String(body.work_date || "")
    const reason = String(body.reason || "").trim()
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !reason) return NextResponse.json({ error: "Employee, work date and reason are required" }, { status: 400 })
    const employees = await query<any[]>("SELECT id, employee_name FROM hr_employees WHERE id=? LIMIT 1", [employeeId])
    if (!employees.length) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
    const requestId = `REG-${Date.now()}`
    await query("INSERT INTO hr_attendance_regularisation (request_id, attendance_id, employee_id, employee_name, work_date, requested_clock_in, requested_clock_out, reason, attachment_path) VALUES (?,?,?,?,?,?,?,?,?)", [requestId, body.attendance_id || null, employeeId, employees[0].employee_name, workDate, body.requested_clock_in || null, body.requested_clock_out || null, reason, body.attachment_path || null])
    return NextResponse.json({ requestId }, { status: 201 })
  } catch { return NextResponse.json({ error: "Unable to create request" }, { status: 500 }) }
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const body = await request.json()
  if (!["Approved", "Rejected", "Pending"].includes(body.status) || !body.id) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  await query("UPDATE hr_attendance_regularisation SET status=?, reviewed_by=?, reviewed_at=NOW() WHERE id=?", [body.status, session.name, body.id])
  return NextResponse.json({ ok: true })
}
