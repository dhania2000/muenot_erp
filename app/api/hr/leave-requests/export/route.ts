import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, getEmployeeByEmail } from "@/lib/hr-leave"

function csvCell(value: any) {
  const s = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_requests"))
  const self = await getEmployeeByEmail(session.email)

  const sp = new URL(request.url).searchParams
  const where: string[] = []
  const args: any[] = []

  if (!canManage) {
    if (self) {
      where.push("(r.employee_id = ? OR r.applied_by = ?)")
      args.push(self.id, session.userId)
    } else {
      where.push("r.applied_by = ?")
      args.push(session.userId)
    }
  }

  const status = sp.get("status")
  if (status && status !== "all") {
    where.push("r.status = ?")
    args.push(status)
  }
  const leaveType = sp.get("leave_type")
  if (leaveType && leaveType !== "all") {
    where.push("r.leave_type_id = ?")
    args.push(leaveType)
  }
  const from = sp.get("from")
  const to = sp.get("to")
  if (from) {
    where.push("r.to_date >= ?")
    args.push(from)
  }
  if (to) {
    where.push("r.from_date <= ?")
    args.push(to)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = await query<any[]>(
    `SELECT r.request_id, r.employee_name, e.department, lt.leave_type, r.from_date, r.to_date,
       r.days, r.paid_days, r.lop_days, r.is_half_day, r.status, r.manager_name, r.hr_reviewer_name,
       r.reason, r.requested_at
     FROM hr_leave_requests r
     LEFT JOIN hr_employees e ON e.id = r.employee_id
     LEFT JOIN hr_leave_types lt ON lt.leave_type_id = r.leave_type_id OR CAST(lt.id AS CHAR) = r.leave_type_id
     ${whereSql}
     ORDER BY r.requested_at DESC`,
    args,
  )

  const headers = [
    "Request ID", "Employee", "Department", "Leave Type", "From", "To", "Days",
    "Paid Days", "LOP Days", "Half Day", "Status", "Manager", "HR Reviewer", "Reason", "Requested At",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        r.request_id, r.employee_name, r.department, r.leave_type,
        String(r.from_date).slice(0, 10), String(r.to_date).slice(0, 10), r.days,
        r.paid_days, r.lop_days, r.is_half_day ? "Yes" : "No", r.status,
        r.manager_name, r.hr_reviewer_name, r.reason,
        r.requested_at ? String(r.requested_at).slice(0, 19).replace("T", " ") : "",
      ].map(csvCell).join(","),
    )
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leave-requests-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
