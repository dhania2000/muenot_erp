import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftChangeSchema, getEmployeeByEmailFull } from "@/lib/hr-shift-change"

async function resolvePrivilege(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_change_requests")
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV export honouring the same permission scope, filters and search as the list. */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return new Response("Unauthorized", { status: 401 })
  await ensureShiftChangeSchema()

  const canManage = await resolvePrivilege(session)
  const self = await getEmployeeByEmailFull(session.email)
  const sp = new URL(request.url).searchParams

  const where: string[] = []
  const args: any[] = []
  if (!canManage) {
    if (self) {
      where.push("(r.employee_id = ? OR r.created_by = ?)")
      args.push(self.id, session.userId)
    } else {
      where.push("r.created_by = ?")
      args.push(session.userId)
    }
  } else if (sp.get("scope") === "mine" && self) {
    where.push("r.employee_id = ?")
    args.push(self.id)
  }
  const status = sp.get("status")
  if (status && status !== "all") {
    where.push("r.status = ?")
    args.push(status)
  }
  const changeType = sp.get("change_type")
  if (changeType && changeType !== "all") {
    where.push("r.change_type = ?")
    args.push(changeType)
  }
  const department = sp.get("department")
  if (department && department !== "all") {
    where.push("e.department = ?")
    args.push(department)
  }
  const requestedShift = sp.get("requested_shift_id")
  if (requestedShift && requestedShift !== "all") {
    where.push("r.requested_shift_id = ?")
    args.push(requestedShift)
  }
  const from = sp.get("from")
  const to = sp.get("to")
  if (from) {
    where.push("(r.to_date IS NULL OR r.to_date >= ?)")
    args.push(from)
  }
  if (to) {
    where.push("r.from_date <= ?")
    args.push(to)
  }
  if (sp.get("view") === "upcoming") where.push("r.status = 'Approved' AND r.from_date > CURDATE()")
  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push("(r.request_id LIKE ? OR r.employee_name LIKE ? OR e.employee_id LIKE ?)")
    args.push(like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = await query<any[]>(
    `SELECT r.request_id, r.employee_name, e.employee_id AS employee_code, e.department,
            cs.shift_name AS current_shift, rs.shift_name AS requested_shift,
            r.change_type, r.from_date, r.to_date, r.reason, r.status, r.approver_name,
            r.created_at, r.reviewed_at
     FROM hr_shift_change_requests r
     LEFT JOIN hr_employees e ON e.id = r.employee_id
     LEFT JOIN hr_shifts cs ON cs.id = r.current_shift_id
     LEFT JOIN hr_shifts rs ON rs.id = r.requested_shift_id
     ${whereSql}
     ORDER BY r.created_at DESC, r.id DESC LIMIT 5000`,
    args,
  )

  const headers = [
    "Request ID", "Employee", "Employee ID", "Department", "Current Shift", "Requested Shift",
    "Type", "Effective From", "Effective To", "Reason", "Status", "Approver", "Created At", "Approved At",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        r.request_id, r.employee_name, r.employee_code, r.department, r.current_shift, r.requested_shift,
        r.change_type, r.from_date ? String(r.from_date).slice(0, 10) : "",
        r.to_date ? String(r.to_date).slice(0, 10) : "",
        r.reason, r.status, r.approver_name,
        r.created_at ? String(r.created_at).slice(0, 19).replace("T", " ") : "",
        r.reviewed_at ? String(r.reviewed_at).slice(0, 19).replace("T", " ") : "",
      ]
        .map(csvCell)
        .join(","),
    )
  }

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="shift-change-requests-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
