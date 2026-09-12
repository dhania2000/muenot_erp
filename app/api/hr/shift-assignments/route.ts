import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftAssignmentSchema,
  createAssignment,
  deriveState,
  getEmployeeByEmail,
  type Actor,
  type ChangeType,
  type CreateAssignmentInput,
} from "@/lib/hr-shift-assignments"

// RBAC: viewing vs. managing vs. override. Admins bypass all three.
async function canManage(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.manage_shift_assignments")
}
async function canView(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_assignments")
}
async function canOverride(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.override_shift_assignments")
}

const JOINS = `
  LEFT JOIN hr_employees e ON e.id = a.employee_id
  LEFT JOIN hr_shifts s ON s.id = a.shift_id`

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftAssignmentSchema()

  const manage = await canManage(session)
  const view = manage || (await canView(session))
  const self = await getEmployeeByEmail(session.email)
  const sp = new URL(request.url).searchParams

  const where: string[] = []
  const args: any[] = []

  // Self-service scoping (§37, §U): non-privileged users only see their own.
  if (!view) {
    if (self) {
      where.push("a.employee_id = ?")
      args.push(self.id)
    } else {
      where.push("1 = 0")
    }
  } else if (sp.get("scope") === "mine" && self) {
    where.push("a.employee_id = ?")
    args.push(self.id)
  }

  const employeeId = sp.get("employee_id")
  if (employeeId && employeeId !== "all") {
    where.push("a.employee_id = ?")
    args.push(employeeId)
  }
  const department = sp.get("department")
  if (department && department !== "all") {
    where.push("e.department = ?")
    args.push(department)
  }
  const shiftId = sp.get("shift_id")
  if (shiftId && shiftId !== "all") {
    where.push("a.shift_id = ?")
    args.push(shiftId)
  }
  const changeType = sp.get("change_type")
  if (changeType && changeType !== "all") {
    where.push("a.change_type = ?")
    args.push(changeType)
  }
  const source = sp.get("source")
  if (source && source !== "all") {
    where.push("a.source_type = ?")
    args.push(source)
  }
  // Derived-state filter / quick views (Active Now / Upcoming / Historical / Inactive).
  const state = sp.get("state") || sp.get("view")
  if (state === "active_now" || state === "current") {
    where.push("a.status = 'Active' AND a.effective_from <= CURDATE() AND (a.effective_to IS NULL OR a.effective_to >= CURDATE())")
  } else if (state === "upcoming") {
    where.push("a.status = 'Active' AND a.effective_from > CURDATE()")
  } else if (state === "historical" || state === "past") {
    where.push("a.status = 'Active' AND a.effective_to IS NOT NULL AND a.effective_to < CURDATE()")
  } else if (state === "inactive") {
    where.push("a.status = 'Inactive'")
  }
  // Effective date range overlap.
  const from = sp.get("from")
  const to = sp.get("to")
  if (from) {
    where.push("(a.effective_to IS NULL OR a.effective_to >= ?)")
    args.push(from)
  }
  if (to) {
    where.push("a.effective_from <= ?")
    args.push(to)
  }
  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push(
      "(a.assignment_id LIKE ? OR e.employee_name LIKE ? OR e.employee_id LIKE ? OR s.shift_name LIKE ? OR s.shift_id LIKE ? OR s.shift_code LIKE ?)",
    )
    args.push(like, like, like, like, like, like)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const countRows = await query<{ total: number }[]>(
    `SELECT COUNT(*) AS total FROM hr_shift_assignments a ${JOINS} ${whereSql}`,
    args,
  )
  const total = Number(countRows[0]?.total || 0)

  const page = Math.max(1, Number(sp.get("page")) || 1)
  const pageSize = Math.min(500, Math.max(1, Number(sp.get("pageSize")) || 25))
  const offset = (page - 1) * pageSize

  const rows = await query<any[]>(
    `SELECT a.id, a.assignment_id, a.employee_id, a.shift_id, a.effective_from, a.effective_to,
            a.status, a.change_type, a.source_type, a.source_id, a.source_request_id,
            a.assigned_by, a.assigned_by_name, a.notes, a.created_at,
            e.employee_name, e.employee_id AS employee_code, e.department, e.designation,
            s.shift_name, s.shift_code, s.shift_id AS shift_ref, s.start_time, s.end_time,
            s.is_overnight, s.working_hours, s.status AS shift_status
     FROM hr_shift_assignments a ${JOINS} ${whereSql}
     ORDER BY (a.status = 'Active') DESC, a.effective_from DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )

  const today = new Date().toISOString().slice(0, 10)
  const assignments = rows.map((r) => ({ ...r, derived_state: deriveState(r, today) }))

  // Summary cards over the current scope (ignores state filter + pagination).
  const scopeWhere: string[] = []
  const scopeArgs: any[] = []
  if (!view) {
    if (self) { scopeWhere.push("a.employee_id = ?"); scopeArgs.push(self.id) }
    else scopeWhere.push("1 = 0")
  } else if (sp.get("scope") === "mine" && self) {
    scopeWhere.push("a.employee_id = ?"); scopeArgs.push(self.id)
  }
  const scopeSql = scopeWhere.length ? `WHERE ${scopeWhere.join(" AND ")}` : ""
  const summaryRows = await query<any[]>(
    `SELECT
        SUM(status = 'Active' AND effective_from <= CURDATE() AND (effective_to IS NULL OR effective_to >= CURDATE())) AS active_now,
        SUM(status = 'Active' AND effective_from > CURDATE()) AS upcoming,
        SUM(status = 'Active' AND change_type = 'Temporary' AND (effective_to IS NULL OR effective_to >= CURDATE())) AS temporary,
        COUNT(*) AS total
     FROM hr_shift_assignments a ${scopeSql}`,
    scopeArgs,
  )
  const summary = {
    activeNow: Number(summaryRows[0]?.active_now || 0),
    upcoming: Number(summaryRows[0]?.upcoming || 0),
    temporary: Number(summaryRows[0]?.temporary || 0),
    total: Number(summaryRows[0]?.total || 0),
  }

  return NextResponse.json({
    assignments,
    total,
    page,
    pageSize,
    summary,
    canManage: manage,
    canOverride: await canOverride(session),
    self: self ? { id: self.id, name: self.employee_name } : null,
  })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftAssignmentSchema()

  // Direct assignment is restricted to authorized HR/Admin (§36, §37).
  if (!(await canManage(session))) {
    return NextResponse.json({ error: "You do not have permission to create shift assignments." }, { status: 403 })
  }

  const body = await request.json()
  const override = Boolean(body.is_override) && (await canOverride(session))
  const employeeId = Number(body.employee_id)
  if (!employeeId) return NextResponse.json({ error: "Employee is required." }, { status: 400 })
  if (!body.shift_id) return NextResponse.json({ error: "Shift is required." }, { status: 400 })

  const changeType: ChangeType = body.change_type === "Temporary" ? "Temporary" : "Permanent"
  const input: CreateAssignmentInput = {
    employee_id: employeeId,
    shift_id: Number(body.shift_id),
    change_type: changeType,
    effective_from: String(body.effective_from || "").slice(0, 10),
    effective_to: body.effective_to ? String(body.effective_to).slice(0, 10) : null,
    notes: body.notes ? String(body.notes).slice(0, 500) : null,
    source_type: "MANUAL",
    source_id: null,
  }
  // Reason/notes required for a manual administrative assignment (§1, §26).
  if (!input.notes || !input.notes.trim()) {
    return NextResponse.json({ error: "A reason / note is required for a manual assignment." }, { status: 400 })
  }

  // assigned_by is ALWAYS the authenticated user — never trusted from the client (§27).
  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const result = await createAssignment(input, actor, override)
    if (!result.ok) {
      return NextResponse.json(
        { error: result.validation.errors[0] || "Validation failed", validation: result.validation },
        { status: 422 },
      )
    }
    return NextResponse.json({ assignment_id: result.assignmentId }, { status: 201 })
  } catch (error) {
    console.log("[v0] shift-assignment create failed", (error as Error).message)
    return NextResponse.json({ error: "Could not create the shift assignment." }, { status: 500 })
  }
}
