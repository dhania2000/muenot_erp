import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import {
  ACTIVE_STATUSES,
  activeSessionForUser,
  buildCallView,
  canPlaceCall,
  getSessionRow,
  logCallEvent,
  notifyUser,
  resolveEmployeeTarget,
  type CallType,
} from "@/lib/calls-core"

export const dynamic = "force-dynamic"

/**
 * POST /api/calls — initiate an internal ERP-to-ERP employee call.
 *
 * Security (Phase 38/39): the caller is taken from the authenticated session,
 * never the request body. The receiver is resolved from the HR Employee Master
 * id server-side and validated (exists + active + has a login account). The
 * caller's permission is enforced via the existing RBAC matrix. Duplicate and
 * concurrent active sessions are prevented (Phase 13/43/69/70).
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()

  const body = await request.json().catch(() => ({}))
  const receiverEmployeeId = Number(body.receiverEmployeeId)
  const callType: CallType = body.callType === "video" ? "video" : "audio"
  if (!Number.isFinite(receiverEmployeeId) || receiverEmployeeId <= 0) {
    return NextResponse.json({ error: "A valid employee is required." }, { status: 400 })
  }

  // Permission (Phase 4/62).
  if (!(await canPlaceCall(session, callType))) {
    return NextResponse.json({ error: "You do not have permission to place this call." }, { status: 403 })
  }

  // Resolve + validate the receiver from the HR Employee Master (Phase 39/40/58).
  const target = await resolveEmployeeTarget(receiverEmployeeId)
  if (!target) return NextResponse.json({ error: "Employee not found." }, { status: 404 })
  if (!target.active) {
    return NextResponse.json({ error: "This employee is inactive and cannot be called." }, { status: 409 })
  }
  if (!target.userId) {
    return NextResponse.json(
      { error: "This employee has no login account and cannot receive internal calls." },
      { status: 409 },
    )
  }
  if (target.userId === session.userId) {
    return NextResponse.json({ error: "You cannot call yourself." }, { status: 400 })
  }

  // Caller must not already be on a call (Phase 43).
  const myActive = await activeSessionForUser(session.userId)
  if (myActive) {
    return NextResponse.json({ error: "You are already on a call.", code: "self_busy" }, { status: 409 })
  }

  // Receiver busy? (Phase 13) — do not create a duplicate session; log a busy
  // attempt so it still shows in history as an outgoing busy call.
  const receiverActive = await activeSessionForUser(target.userId)
  if (receiverActive) {
    const callerEmp = body.callerEmployeeId ? Number(body.callerEmployeeId) : null
    const ins = await query<any>(
      `INSERT INTO internal_call_sessions
         (caller_user_id, receiver_user_id, caller_employee_id, receiver_employee_id, call_type, status, end_reason, origin, ended_at)
       VALUES (?,?,?,?,?,'busy','receiver_busy',?, NOW())`,
      [session.userId, target.userId, callerEmp, target.employeeId, callType, body.origin || "employee"],
    )
    await logCallEvent(ins.insertId, "busy", session.userId, "receiver_busy")
    return NextResponse.json({ error: `${target.name} is busy on another call.`, code: "busy" }, { status: 409 })
  }

  // Concurrency guard (Phase 70): re-check both sides inside a tight window.
  const dup = await query<any[]>(
    `SELECT id FROM internal_call_sessions
      WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
        AND ((caller_user_id = ? OR receiver_user_id = ?) OR (caller_user_id = ? OR receiver_user_id = ?))
      LIMIT 1`,
    [...ACTIVE_STATUSES, session.userId, session.userId, target.userId, target.userId],
  )
  if (dup.length) {
    return NextResponse.json({ error: "A call is already in progress.", code: "busy" }, { status: 409 })
  }

  const callerEmp = body.callerEmployeeId ? Number(body.callerEmployeeId) : null
  const projectId = body.projectId ? Number(body.projectId) : null
  const taskId = body.taskId ? Number(body.taskId) : null
  const projectName = body.projectName ? String(body.projectName).slice(0, 200) : null
  const taskName = body.taskName ? String(body.taskName).slice(0, 200) : null
  const origin = body.origin ? String(body.origin).slice(0, 32) : "employee"

  const result = await query<any>(
    `INSERT INTO internal_call_sessions
       (caller_user_id, receiver_user_id, caller_employee_id, receiver_employee_id, call_type, status,
        project_id, project_name, task_id, task_name, origin, started_at)
     VALUES (?,?,?,?,?,'ringing',?,?,?,?,?, NOW())`,
    [session.userId, target.userId, callerEmp, target.employeeId, callType, projectId, projectName, taskId, taskName, origin],
  )
  const sessionId = result.insertId as number
  await logCallEvent(sessionId, "initiated", session.userId, `${callType} call`)
  await logCallEvent(sessionId, "ringing", session.userId)

  // Notify the receiver via the existing notification feed (Phase 50).
  await notifyUser(
    target.userId,
    "incoming_call",
    `Incoming ${callType} call`,
    `You have an incoming ${callType} call.`,
  )

  const row = await getSessionRow(sessionId)
  const view = await buildCallView(row!, session.userId)
  return NextResponse.json({ session: view }, { status: 201 })
}
