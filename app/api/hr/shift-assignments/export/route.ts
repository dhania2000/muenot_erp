import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftAssignmentSchema, deriveState, getEmployeeByEmail } from "@/lib/hr-shift-assignments"

async function canView(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_assignments")
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV export honouring the same permission scope, filters and search as the list (§46). */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return new Response("Unauthorized", { status: 401 })
  await ensureShiftAssignmentSchema()

  const view = await canView(session)
  const self = await getEmployeeByEmail(session.email)
  const sp = new URL(request.url).searchParams

  const where: string[] = []
  const args: any[] = []
  if (!view) {
    if (self) { where.push("a.employee_id = ?"); args.push(self.id) }
    else where.push("1 = 0")
  } else if (sp.get("scope") === "mine" && self) {
    where.push("a.employee_id = ?"); args.push(self.id)
  }
  const employeeId = sp.get("employee_id")
  if (employeeId && employeeId !== "all") { where.push("a.employee_id = ?"); args.push(employeeId) }
  const department = sp.get("department")
  if (department && department !== "all") { where.push("e.department = ?"); args.push(department) }
  const shiftId = sp.get("shift_id")
  if (shiftId && shiftId !== "all") { where.push("a.shift_id = ?"); args.push(shiftId) }
  const changeType = sp.get("change_type")
  if (changeType && changeType !== "all") { where.push("a.change_type = ?"); args.push(changeType) }
  const source = sp.get("source")
  if (source && source !== "all") { where.push("a.source_type = ?"); args.push(source) }
  const state = sp.get("state") || sp.get("view")
  if (state === "active_now" || state === "current") where.push("a.status = 'Active' AND a.effective_from <= CURDATE() AND (a.effective_to IS NULL OR a.effective_to >= CURDATE())")
  else if (state === "upcoming") where.push("a.status = 'Active' AND a.effective_from > CURDATE()")
  else if (state === "historical" || state === "past") where.push("a.status = 'Active' AND a.effective_to IS NOT NULL AND a.effective_to < CURDATE()")
  else if (state === "inactive") where.push("a.status = 'Inactive'")
  const from = sp.get("from")
  const to = sp.get("to")
  if (from) { where.push("(a.effective_to IS NULL OR a.effective_to >= ?)"); args.push(from) }
  if (to) { where.push("a.effective_from <= ?"); args.push(to) }
  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push("(a.assignment_id LIKE ? OR e.employee_name LIKE ? OR e.employee_id LIKE ? OR s.shift_name LIKE ?)")
    args.push(like, like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = await query<any[]>(
    `SELECT a.assignment_id, e.employee_name, e.employee_id AS employee_code, e.department,
            s.shift_name, s.shift_id AS shift_ref, s.start_time, s.end_time,
            a.change_type, a.effective_from, a.effective_to, a.status, a.source_type,
            a.assigned_by_name, a.notes
     FROM hr_shift_assignments a
     LEFT JOIN hr_employees e ON e.id = a.employee_id
     LEFT JOIN hr_shifts s ON s.id = a.shift_id
     ${whereSql}
     ORDER BY (a.status = 'Active') DESC, a.effective_from DESC, a.id DESC LIMIT 5000`,
    args,
  )

  const today = new Date().toISOString().slice(0, 10)
  const headers = [
    "Assignment ID", "Employee", "Employee ID", "Department", "Shift", "Shift ID",
    "Start Time", "End Time", "Type", "Effective From", "Effective To",
    "Status", "State", "Source", "Assigned By", "Notes",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        r.assignment_id, r.employee_name, r.employee_code, r.department, r.shift_name, r.shift_ref,
        r.start_time, r.end_time, r.change_type,
        r.effective_from ? String(r.effective_from).slice(0, 10) : "",
        r.effective_to ? String(r.effective_to).slice(0, 10) : "",
        r.status, deriveState(r, today), r.source_type, r.assigned_by_name, r.notes,
      ]
        .map(csvCell)
        .join(","),
    )
  }

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="shift-assignments-${today}.csv"`,
    },
  })
}
