import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { nextRecordId } from "@/lib/record-ids"
import {
  ensureLeaveSchema,
  getEmployeeByEmail,
  createLeaveRequest,
  type Actor,
} from "@/lib/hr-leave"
import { emitHrEmailEvent } from "@/lib/hr-email-automation"

/** True when the session may see and act on every employee's leave. */
async function resolvePrivilege(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_leave_requests")
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage = await resolvePrivilege(session)
  const self = await getEmployeeByEmail(session.email)

  const sp = new URL(request.url).searchParams
  const where: string[] = []
  const args: any[] = []

  // Scope: non-privileged users only ever see their own requests.
  if (!canManage) {
    if (self) {
      where.push("(r.employee_id = ? OR r.applied_by = ?)")
      args.push(self.id, session.userId)
    } else {
      where.push("r.applied_by = ?")
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

  const leaveType = sp.get("leave_type")
  if (leaveType && leaveType !== "all") {
    where.push("r.leave_type_id = ?")
    args.push(leaveType)
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

  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push("(r.employee_name LIKE ? OR r.request_id LIKE ? OR r.reason LIKE ?)")
    args.push(like, like, like)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const countRows = await query<{ total: number }[]>(
    `SELECT COUNT(*) AS total FROM hr_leave_requests r LEFT JOIN hr_employees e ON e.id = r.employee_id ${whereSql}`,
    args,
  )
  const total = Number(countRows[0]?.total || 0)

  const page = Math.max(1, Number(sp.get("page")) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 25))
  const offset = (page - 1) * pageSize

  const requests = await query<any[]>(
    `SELECT r.*, e.department, e.designation, lt.leave_type
     FROM hr_leave_requests r
     LEFT JOIN hr_employees e ON e.id = r.employee_id
     LEFT JOIN hr_leave_types lt ON lt.leave_type_id = r.leave_type_id OR CAST(lt.id AS CHAR) = r.leave_type_id
     ${whereSql}
     ORDER BY r.requested_at DESC, r.id DESC
     LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )

  // Summary cards over the current filter scope (ignoring status/pagination).
  const summaryWhere: string[] = []
  const summaryArgs: any[] = []
  if (!canManage) {
    if (self) {
      summaryWhere.push("(r.employee_id = ? OR r.applied_by = ?)")
      summaryArgs.push(self.id, session.userId)
    } else {
      summaryWhere.push("r.applied_by = ?")
      summaryArgs.push(session.userId)
    }
  } else if (sp.get("scope") === "mine" && self) {
    summaryWhere.push("r.employee_id = ?")
    summaryArgs.push(self.id)
  }
  const summarySql = summaryWhere.length ? `WHERE ${summaryWhere.join(" AND ")}` : ""
  const summaryRows = await query<any[]>(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(days),0) AS days FROM hr_leave_requests r ${summarySql} GROUP BY status`,
    summaryArgs,
  )
  const summary = {
    total: 0,
    pending: 0,
    managerApproved: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
    awaitingMyAction: 0,
  }
  for (const row of summaryRows) {
    const count = Number(row.count)
    summary.total += count
    if (row.status === "Pending") summary.pending += count
    else if (row.status === "Manager Approved") summary.managerApproved += count
    else if (row.status === "HR Approved") summary.approved += count
    else if (row.status === "Manager Rejected" || row.status === "HR Rejected") summary.rejected += count
    else if (row.status === "Cancelled") summary.cancelled += count
  }
  if (canManage) {
    summary.awaitingMyAction = summary.pending + summary.managerApproved
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
  await ensureLeaveSchema()

  const body = await request.json()
  const canManage = await resolvePrivilege(session)

  // Non-privileged applicants can only file for themselves (auto-identified).
  let employeeId = Number(body.employee_id)
  if (!canManage) {
    const self = await getEmployeeByEmail(session.email)
    if (!self) {
      return NextResponse.json(
        { error: "No employee record is linked to your account. Contact HR to apply for leave." },
        { status: 400 },
      )
    }
    employeeId = self.id
  }

  if (!employeeId || !body.leave_type_id || !body.from_date || !body.to_date) {
    return NextResponse.json({ error: "Employee, leave type and dates are required." }, { status: 400 })
  }
  if (!body.reason || !String(body.reason).trim()) {
    return NextResponse.json({ error: "A reason is required." }, { status: 400 })
  }

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  const requestId = await nextRecordId("LR")

  try {
    const result = await createLeaveRequest(
      {
        employee_id: employeeId,
        leave_type_id: body.leave_type_id,
        from_date: body.from_date,
        to_date: body.to_date,
        is_half_day: Boolean(body.is_half_day),
        half_day_session: body.half_day_session ?? null,
        reason: String(body.reason),
        attachment_url: body.attachment_url ?? null,
      },
      actor,
      requestId,
    )
    if (!result.ok) {
      return NextResponse.json(
        { error: result.validation.errors[0]?.message || "Validation failed", validation: result.validation },
        { status: 422 },
      )
    }
    // Acknowledge the submission with an automated email (guarded).
    try {
      const [row] = await query<any[]>(
        `SELECT r.request_id, r.employee_id, r.days, r.from_date, r.to_date, r.reason, r.status,
                e.reporting_manager, lt.leave_type
         FROM hr_leave_requests r
         LEFT JOIN hr_employees e ON e.id = r.employee_id
         LEFT JOIN hr_leave_types lt ON lt.leave_type_id = r.leave_type_id OR CAST(lt.id AS CHAR) = r.leave_type_id
         WHERE r.request_id = ? LIMIT 1`,
        [result.requestId],
      )
      if (row) {
        await emitHrEmailEvent("leave_submitted", {
          employeeId: Number(row.employee_id),
          sourceRecordId: row.request_id,
          actorId: session.userId,
          managerName: row.reporting_manager,
          vars: {
            request_id: row.request_id,
            leave_type: row.leave_type ?? "",
            from_date: String(row.from_date).slice(0, 10),
            to_date: String(row.to_date).slice(0, 10),
            days: row.days,
            reason: row.reason,
            status: row.status,
          },
        })
      }
    } catch (error) {
      console.log("[v0] leave submit email emit failed", (error as Error).message)
    }

    return NextResponse.json({ request_id: result.requestId, validation: result.validation }, { status: 201 })
  } catch (error) {
    console.log("[v0] leave create failed", (error as Error).message)
    return NextResponse.json({ error: "Could not create leave request." }, { status: 500 })
  }
}
