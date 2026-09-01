import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const rows = await query<any[]>(`SELECT b.*, e.employee_name, e.employee_code FROM hr_leave_balances b JOIN employees e ON e.id=b.employee_id ORDER BY b.year DESC, e.employee_name`)
  return NextResponse.json({ balances: rows })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  const employeeId = Number(body.employee_id)
  const leaveTypeId = Number(body.leave_type_id)
  const year = Number(body.year)
  if (!employeeId || !leaveTypeId || !year) return NextResponse.json({ error: "Employee, leave type, and year are required" }, { status: 400 })
  const values = [employeeId, leaveTypeId, year, ...["opening", "accrued", "used", "pending", "adjusted"].map((key) => Number(body[key] || 0))]
  await query(`INSERT INTO hr_leave_balances (employee_id, leave_type_id, year, opening, accrued, used, pending, adjusted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE opening=VALUES(opening), accrued=VALUES(accrued), used=VALUES(used), pending=VALUES(pending), adjusted=VALUES(adjusted)`, values)
  return NextResponse.json({ ok: true })
}
