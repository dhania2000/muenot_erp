import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftChangeSchema,
  getEmployeeByEmailFull,
  createShiftChangeRequest,
  type Actor,
  type CreateInput,
} from "@/lib/hr-shift-change"

/** True when the session may see and act on every employee's requests. */
async function resolvePrivilege(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_change_requests")
}
async function canOverride(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.override_shift_change_requests")
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftChangeSchema()

  const canManage = await resolvePrivilege(session)
  const self = await getEmployeeByEmailFull(session.email)
  const sp = new URL(request.url).searchParams

  const where: string[] = []
  const args: any[] = []

  // Non-privileged users only ever see their own requests (server-enforced).
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
  const employeeId = sp.get("employee_id")
  if (employeeId && canManage) {
    where.push("r.employee_id = ?")
    args.push(employeeId)
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
  const approver = sp.get("approver_id")
  if (approver && canManage) {
    where.push("r.approver_id = ?")
    args.push(approver)
  }
  // Effective date range.
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
  // Quick view: upcoming changes (approved, future-dated).
  if (sp.get("view") === "upcoming") {
    where.push("r.status = 'Approved' AND r.from_date > CURDATE()")
  }

  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push(
      "(r.request_id LIKE ? OR r.employee_name LIKE ? OR e.employee_id LIKE ? OR cs.shift_name LIKE ? OR rs.shift_name LIKE ?)",
    )
    args.push(like, like, like, like, like)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const joins = `
    LEFT JOIN hr_employees e ON e.id = r.employee_id
    LEFT JOIN hr_shifts cs ON cs.id = r.current_shift_id
    LEFT JOIN hr_shifts rs ON rs.id = r.requested_shift_id`

  const countRows = await query<{ total: number }[]>(
    `SELECT COUNT(*) AS total FROM hr_shift_change_requests r ${joins} ${whereSql}`,
    args,
  )
  const total = Number(countRows[0]?.total || 0)

  const page = Math.max(1, Number(sp.get("page")) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 25))
  const offset = (page - 1) * pageSize

  const requests = await query<any[]>(
    `SELECT r.*, e.employee_id AS employee_code, e.department, e.designation,
            cs.shift_name AS current_shift_name, cs.shift_code AS current_shift_code,
            cs.start_time AS current_start, cs.end_time AS current_end,
            rs.shift_name AS requested_shift_name, rs.shift_code AS requested_shift_code,
            rs.start_time AS requested_start, rs.end_time AS requested_end
     FROM hr_shift_change_requests r ${joins} ${whereSql}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )

  // Summary over the current scope (ignores status filter / pagination).
  const scopeWhere: string[] = []
  const scopeArgs: any[] = []
  if (!canManage) {
    if (self) {
      scopeWhere.push("(r.employee_id = ? OR r.created_by = ?)")
      scopeArgs.push(self.id, session.userId)
    } else {
      scopeWhere.push("r.created_by = ?")
      scopeArgs.push(session.userId)
    }
  } else if (sp.get("scope") === "mine" && self) {
    scopeWhere.push("r.employee_id = ?")
    scopeArgs.push(self.id)
  }
  const scopeSql = scopeWhere.length ? `WHERE ${scopeWhere.join(" AND ")}` : ""
  const summaryRows = await query<any[]>(
    `SELECT status, COUNT(*) AS count,
            SUM(status = 'Approved' AND from_date > CURDATE()) AS upcoming
     FROM hr_shift_change_requests r ${scopeSql} GROUP BY status`,
    scopeArgs,
  )
  const summary = { total: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0, withdrawn: 0, upcoming: 0 }
  for (const row of summaryRows) {
    const count = Number(row.count)
    summary.total += count
    summary.upcoming += Number(row.upcoming || 0)
    if (row.status === "Pending") summary.pending += count
    else if (row.status === "Approved") summary.approved += count
    else if (row.status === "Rejected") summary.rejected += count
    else if (row.status === "Cancelled") summary.cancelled += count
    else if (row.status === "Withdrawn") summary.withdrawn += count
  }

  return NextResponse.json({
    requests,
    total,
    page,
    pageSize,
    summary,
    canManage,
    self: self ? { id: self.id, name: self.employee_name, department: self.department } : null,
  })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftChangeSchema()

  const body = await request.json()
  const canManage = await resolvePrivilege(session)
  const override = Boolean(body.is_override) && (await canOverride(session))

  // Non-privileged applicants can only file for themselves (auto-identified).
  let employeeId = Number(body.employee_id)
  if (!canManage) {
    const self = await getEmployeeByEmailFull(session.email)
    if (!self) {
      return NextResponse.json(
        { error: "No employee record is linked to your account. Contact HR to request a shift change." },
        { status: 400 },
      )
    }
    employeeId = self.id
  }
  if (!employeeId) return NextResponse.json({ error: "Employee is required." }, { status: 400 })

  const input: CreateInput = {
    employee_id: employeeId,
    requested_shift_id: Number(body.requested_shift_id),
    change_type: body.change_type === "Temporary" ? "Temporary" : "Permanent",
    from_date: String(body.from_date || "").slice(0, 10),
    to_date: body.to_date ? String(body.to_date).slice(0, 10) : null,
    reason_category: body.reason_category ?? null,
    reason: String(body.reason || ""),
    attachment_url: body.attachment_url ?? null,
    attachment_name: body.attachment_name ?? null,
    support_ticket_id: body.support_ticket_id ?? null,
    is_override: override,
    override_reason: override ? (body.override_reason ?? null) : null,
  }

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const result = await createShiftChangeRequest(input, actor, override)
    if (!result.ok) {
      return NextResponse.json(
        { error: result.validation.errors[0] || "Validation failed", validation: result.validation },
        { status: 422 },
      )
    }
    return NextResponse.json({ request_id: result.requestId, validation: result.validation }, { status: 201 })
  } catch (error) {
    console.log("[v0] shift-change create failed", (error as Error).message)
    return NextResponse.json({ error: "Could not create shift change request." }, { status: 500 })
  }
}
