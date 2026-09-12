import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftChangeSchema,
  getEmployeeByEmailFull,
  getShiftDetail,
  getTimeline,
  transitionRequest,
  detectConflicts,
  type Actor,
  type RequestAction,
} from "@/lib/hr-shift-change"

async function resolvePrivilege(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_change_requests")
}
async function canOverride(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.override_shift_change_requests")
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftChangeSchema()
  const { id } = await params

  const rows = await query<any[]>(
    `SELECT r.*, e.employee_id AS employee_code, e.department, e.designation, e.reporting_manager, e.employment_status,
            e.official_email, e.personal_email
     FROM hr_shift_change_requests r
     LEFT JOIN hr_employees e ON e.id = r.employee_id
     WHERE r.request_id = ? OR CAST(r.id AS CHAR) = ? LIMIT 1`,
    [id, id],
  )
  const request = rows[0]
  if (!request) return NextResponse.json({ error: "Request not found" }, { status: 404 })

  const canManage = await resolvePrivilege(session)
  const self = await getEmployeeByEmailFull(session.email)
  const isOwner =
    (self && Number(self.id) === Number(request.employee_id)) || Number(request.created_by) === Number(session.userId)
  if (!canManage && !isOwner) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [currentShift, requestedShift] = await Promise.all([
    request.current_shift_id ? getShiftDetail(Number(request.current_shift_id)) : Promise.resolve(null),
    request.requested_shift_id ? getShiftDetail(Number(request.requested_shift_id)) : Promise.resolve(null),
  ])

  const timeline = await getTimeline(request.request_id)

  // Related shift assignment (both-direction traceability, §24, §59).
  let assignment: any = null
  if (request.applied_assignment_id) {
    const aRows = await query<any[]>(
      `SELECT assignment_id, shift_id, effective_from, effective_to, status, source_request_id, change_type
       FROM hr_shift_assignments WHERE assignment_id = ? LIMIT 1`,
      [request.applied_assignment_id],
    )
    assignment = aRows[0] ?? null
  }

  // Live conflict re-check for the approver view (advisory).
  let conflicts = null
  if (canManage && request.status === "Pending") {
    conflicts = await detectConflicts({
      employeeId: Number(request.employee_id),
      employeeShift: null,
      fromDate: String(request.from_date).slice(0, 10),
      toDate: request.to_date ? String(request.to_date).slice(0, 10) : null,
      requestedShiftId: Number(request.requested_shift_id),
      excludeRequestId: request.request_id,
    })
  }

  // Team context on the requested shift (advisory, §57/§58).
  let teamOnRequestedShift: any[] = []
  if (canManage && request.requested_shift_id) {
    teamOnRequestedShift = await query<any[]>(
      `SELECT DISTINCT e.employee_name, e.employee_id AS employee_code
       FROM hr_shift_assignments a JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.shift_id = ? AND a.status = 'Active' AND a.employee_id <> ?
         AND (a.effective_to IS NULL OR a.effective_to >= CURDATE())
       LIMIT 20`,
      [request.requested_shift_id, request.employee_id],
    )
  }

  return NextResponse.json({
    request,
    currentShift,
    requestedShift,
    timeline,
    assignment,
    conflicts,
    teamOnRequestedShift,
    canManage,
    canOverride: await canOverride(session),
    isOwner,
  })
}

const ACTIONS = new Set<RequestAction>(["approve", "reject", "withdraw", "cancel"])

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftChangeSchema()
  const { id } = await params
  const body = await request.json()
  const action = body.action as RequestAction
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "Unknown action" }, { status: 400 })

  const rows = await query<any[]>(
    `SELECT * FROM hr_shift_change_requests WHERE request_id = ? OR CAST(id AS CHAR) = ? LIMIT 1`,
    [id, id],
  )
  const req = rows[0]
  if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 })

  const canManage = await resolvePrivilege(session)
  const self = await getEmployeeByEmailFull(session.email)
  const isOwner =
    (self && Number(self.id) === Number(req.employee_id)) || Number(req.created_by) === Number(session.userId)

  // Authorization by action (server-enforced, §11/§45/§46).
  if (action === "withdraw") {
    if (!isOwner && !canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  } else if (action === "cancel") {
    // Owner may cancel their own Pending request; only managers cancel Approved.
    if (req.status === "Approved" && !canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (!isOwner && !canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  } else if (!canManage) {
    // approve / reject
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const override = Boolean(body.override) && (await canOverride(session))
  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const result = await transitionRequest(req.request_id, action, actor, {
      remarks: body.remarks ?? null,
      canOverride: override,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, status: result.status, appliedAssignmentId: result.appliedAssignmentId })
  } catch (error) {
    console.log("[v0] shift-change transition failed", (error as Error).message)
    return NextResponse.json({ error: "Could not update request." }, { status: 500 })
  }
}
