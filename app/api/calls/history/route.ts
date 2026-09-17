import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import { FEATURE_HISTORY, resolveEmployeeTarget } from "@/lib/calls-core"
import { userHasFeature } from "@/lib/permissions"

export const dynamic = "force-dynamic"

/**
 * GET /api/calls/history — internal call history (Phase 20/21/22/23).
 *
 * Scope: without `employeeId`, returns the caller's own calls. With
 * `employeeId`, returns that employee's calls — allowed for your own record, or
 * for anyone when you hold the View Call History permission. Direction
 * (incoming/outgoing) is computed relative to the SUBJECT employee/user.
 *
 * Filters: type=audio|video, status, direction=incoming|outgoing, projectId,
 * taskId, from/to (date range) and q (free-text on counterpart name/code).
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()

  const sp = new URL(request.url).searchParams
  const employeeId = sp.get("employeeId") ? Number(sp.get("employeeId")) : null

  // Determine the subject user id.
  let subjectUserId = session.userId
  if (employeeId) {
    const target = await resolveEmployeeTarget(employeeId)
    if (!target || !target.userId) return NextResponse.json({ calls: [] })
    subjectUserId = target.userId
    if (subjectUserId !== session.userId) {
      const allowed = await userHasFeature(session.userId, session.role, FEATURE_HISTORY)
      if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }

  const where: string[] = ["(s.caller_user_id = ? OR s.receiver_user_id = ?)"]
  const args: any[] = [subjectUserId, subjectUserId]

  const type = sp.get("type")
  if (type === "audio" || type === "video") {
    where.push("s.call_type = ?")
    args.push(type)
  }
  const status = sp.get("status")
  if (status) {
    where.push("s.status = ?")
    args.push(status)
  }
  const direction = sp.get("direction")
  if (direction === "incoming") {
    where.push("s.receiver_user_id = ?")
    args.push(subjectUserId)
  } else if (direction === "outgoing") {
    where.push("s.caller_user_id = ?")
    args.push(subjectUserId)
  }
  const projectId = sp.get("projectId")
  if (projectId) {
    where.push("s.project_id = ?")
    args.push(Number(projectId))
  }
  const taskId = sp.get("taskId")
  if (taskId) {
    where.push("s.task_id = ?")
    args.push(Number(taskId))
  }
  const from = sp.get("from")
  if (from) {
    where.push("s.started_at >= ?")
    args.push(`${from} 00:00:00`)
  }
  const to = sp.get("to")
  if (to) {
    where.push("s.started_at <= ?")
    args.push(`${to} 23:59:59`)
  }
  const q = (sp.get("q") || "").trim()
  if (q) {
    where.push(
      `(caller_emp.employee_name LIKE ? OR receiver_emp.employee_name LIKE ? OR caller_emp.employee_id LIKE ? OR receiver_emp.employee_id LIKE ?)`,
    )
    const like = `%${q}%`
    args.push(like, like, like, like)
  }

  const rows = await query<any[]>(
    `SELECT s.*,
            caller_emp.employee_name AS caller_name, caller_emp.id AS caller_emp_id,
            caller_emp.designation AS caller_designation, caller_emp.photo_url AS caller_photo,
            receiver_emp.employee_name AS receiver_name, receiver_emp.id AS receiver_emp_id,
            receiver_emp.designation AS receiver_designation, receiver_emp.photo_url AS receiver_photo
       FROM internal_call_sessions s
       LEFT JOIN hr_employees caller_emp ON caller_emp.user_id = s.caller_user_id
       LEFT JOIN hr_employees receiver_emp ON receiver_emp.user_id = s.receiver_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT 300`,
    args,
  )

  const calls = rows.map((r) => {
    const outgoing = Number(r.caller_user_id) === subjectUserId
    return {
      id: Number(r.id),
      direction: outgoing ? "outgoing" : "incoming",
      callType: r.call_type,
      status: r.status,
      endReason: r.end_reason,
      startedAt: r.started_at,
      answeredAt: r.answered_at,
      endedAt: r.ended_at,
      durationSeconds: Number(r.duration_seconds || 0),
      projectId: r.project_id,
      projectName: r.project_name,
      taskId: r.task_id,
      taskName: r.task_name,
      counterpart: outgoing
        ? {
            employeeId: r.receiver_emp_id ? Number(r.receiver_emp_id) : null,
            name: r.receiver_name || "Employee",
            designation: r.receiver_designation,
            photoUrl: r.receiver_photo,
          }
        : {
            employeeId: r.caller_emp_id ? Number(r.caller_emp_id) : null,
            name: r.caller_name || "Employee",
            designation: r.caller_designation,
            photoUrl: r.caller_photo,
          },
    }
  })

  return NextResponse.json({ calls })
}
