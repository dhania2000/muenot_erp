import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftAssignmentSchema,
  getAssignmentEvents,
  deriveState,
  endAssignment,
  setAssignmentStatus,
  updateAssignment,
  getEmployeeByEmail,
  type Actor,
} from "@/lib/hr-shift-assignments"

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

/** Full assignment detail with enriched employee/shift facts + audit history (§33). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftAssignmentSchema()
  const { id } = await params

  const rows = await query<any[]>(
    `SELECT a.*, e.employee_name, e.employee_id AS employee_code, e.department, e.designation,
            e.reporting_manager, e.employment_status,
            s.shift_name, s.shift_code, s.shift_id AS shift_ref, s.start_time, s.end_time,
            s.is_overnight, s.break_minutes, s.working_hours, s.overtime_enabled, s.status AS shift_status
     FROM hr_shift_assignments a
     LEFT JOIN hr_employees e ON e.id = a.employee_id
     LEFT JOIN hr_shifts s ON s.id = a.shift_id
     WHERE a.assignment_id = ? LIMIT 1`,
    [id],
  )
  const a = rows[0]
  if (!a) return NextResponse.json({ error: "Assignment not found" }, { status: 404 })

  // Self-service can only see their own assignment (§37, §U).
  if (!(await canView(session))) {
    const self = await getEmployeeByEmail(session.email)
    if (!self || Number(self.id) !== Number(a.employee_id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const events = await getAssignmentEvents(id)
  return NextResponse.json({
    assignment: { ...a, derived_state: deriveState(a, today) },
    events,
    canManage: await canManage(session),
    canOverride: await canOverride(session),
  })
}

/**
 * Workflow actions on an assignment. action = end | deactivate | reactivate | edit.
 * Never deletes history (§57). assigned_by/employee/id are immutable (§38).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftAssignmentSchema()
  const { id } = await params

  if (!(await canManage(session))) {
    return NextResponse.json({ error: "You do not have permission to modify shift assignments." }, { status: 403 })
  }

  const body = await request.json()
  const action = String(body.action || "")
  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  const reason = body.reason ? String(body.reason).slice(0, 500) : null
  const override = Boolean(body.is_override) && (await canOverride(session))

  try {
    if (action === "end") {
      const effectiveTo = String(body.effective_to || "").slice(0, 10)
      if (!effectiveTo) return NextResponse.json({ error: "An end date is required." }, { status: 400 })
      const result = await endAssignment(id, effectiveTo, actor, reason)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 })
      return NextResponse.json({ ok: true })
    }
    if (action === "deactivate") {
      const result = await setAssignmentStatus(id, "Inactive", actor, reason)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 })
      return NextResponse.json({ ok: true })
    }
    if (action === "reactivate") {
      const result = await setAssignmentStatus(id, "Active", actor, reason)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 })
      return NextResponse.json({ ok: true })
    }
    if (action === "edit") {
      const result = await updateAssignment(
        id,
        {
          effective_from: body.effective_from ? String(body.effective_from).slice(0, 10) : undefined,
          effective_to:
            body.effective_to === undefined ? undefined : body.effective_to ? String(body.effective_to).slice(0, 10) : null,
          notes: body.notes === undefined ? undefined : body.notes ? String(body.notes).slice(0, 500) : null,
          change_type: body.change_type === "Temporary" ? "Temporary" : body.change_type === "Permanent" ? "Permanent" : undefined,
        },
        actor,
        override,
      )
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 })
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 })
  } catch (error) {
    console.log("[v0] shift-assignment patch failed", (error as Error).message)
    return NextResponse.json({ error: "Could not update the assignment." }, { status: 500 })
  }
}
