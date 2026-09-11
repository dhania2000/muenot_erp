import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureLeaveSchema,
  getEmployeeByEmail,
  getTimeline,
  transitionLeave,
  resolveLeaveType,
  getBalanceSnapshot,
  type Actor,
  type LeaveAction,
} from "@/lib/hr-leave"

async function resolvePrivilege(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_leave_requests")
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()
  const { id } = await params

  const rows = await query<any[]>(
    `SELECT r.*, e.department, e.designation, e.official_email, e.personal_email, lt.leave_type, lt.paid
     FROM hr_leave_requests r
     LEFT JOIN hr_employees e ON e.id = r.employee_id
     LEFT JOIN hr_leave_types lt ON lt.leave_type_id = r.leave_type_id OR CAST(lt.id AS CHAR) = r.leave_type_id
     WHERE r.request_id = ? OR CAST(r.id AS CHAR) = ? LIMIT 1`,
    [id, id],
  )
  const request = rows[0]
  if (!request) return NextResponse.json({ error: "Request not found" }, { status: 404 })

  const canManage = await resolvePrivilege(session)
  const self = await getEmployeeByEmail(session.email)
  const isOwner = (self && Number(self.id) === Number(request.employee_id)) || Number(request.applied_by) === Number(session.userId)
  if (!canManage && !isOwner) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const timeline = await getTimeline(request.request_id)
  let breakdown: any[] = []
  try {
    breakdown = request.breakdown ? JSON.parse(request.breakdown) : []
  } catch {
    breakdown = []
  }

  // Live balance snapshot for the request's leave type/year.
  let balance = null
  const leaveType = await resolveLeaveType(request.leave_type_id)
  if (leaveType) {
    const year = new Date(`${String(request.from_date).slice(0, 10)}T00:00:00`).getFullYear()
    balance = await getBalanceSnapshot(Number(request.employee_id), leaveType, year)
  }

  return NextResponse.json({
    request: { ...request, breakdown },
    timeline,
    balance,
    canManage,
    isOwner,
  })
}

const ACTIONS = new Set<LeaveAction>(["manager_approve", "manager_reject", "hr_approve", "hr_reject", "cancel"])

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()
  const { id } = await params
  const body = await request.json()
  const action = body.action as LeaveAction

  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }

  const rows = await query<any[]>(
    `SELECT * FROM hr_leave_requests WHERE request_id = ? OR CAST(id AS CHAR) = ? LIMIT 1`,
    [id, id],
  )
  const leave = rows[0]
  if (!leave) return NextResponse.json({ error: "Request not found" }, { status: 404 })

  const canManage = await resolvePrivilege(session)
  const self = await getEmployeeByEmail(session.email)
  const isOwner = (self && Number(self.id) === Number(leave.employee_id)) || Number(leave.applied_by) === Number(session.userId)

  // Approval/rejection require privilege; cancel is allowed for the owner too.
  if (action === "cancel") {
    if (!canManage && !isOwner) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  } else if (!canManage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const result = await transitionLeave(leave.request_id, action, actor, body.remarks ?? null)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, status: result.status })
  } catch (error) {
    console.log("[v0] leave transition failed", (error as Error).message)
    return NextResponse.json({ error: "Could not update leave request." }, { status: 500 })
  }
}
