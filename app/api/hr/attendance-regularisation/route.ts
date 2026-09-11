import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { logEmployeeEvent } from "@/lib/hr-employee-events"
import {
  ensureRegularisationSchema,
  canManageRegularisation,
  resolveSessionEmployee,
  buildDayInsight,
  approveAndApply,
  toDateTime,
  CORRECTION_TYPES,
} from "@/lib/hr-regularisation"
import { getEmployeeById } from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Attendance Regularisation API.
//   GET   — permission-scoped list + summary + form context (self/employees).
//   POST  — create a correction request (auto-linked employee, snapshotted
//           current attendance, duplicate + leave guards, auto Request ID).
//   PATCH — approve (applies to attendance) / reject / cancel, self-approval
//           blocked, approved requests immutable, every action audited.
// Employees manage only their own requests; hr.manage_regularisation unlocks
// the approver view over every employee (mirrors the clock-in access model).
// ---------------------------------------------------------------------------

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRegularisationSchema()

    const canManage = await canManageRegularisation(session)
    const self = await resolveSessionEmployee(session)
    const sp = request.nextUrl.searchParams

    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, ...values: unknown[]) => {
      where.push(clause)
      params.push(...values)
    }

    // Non-managers are hard-scoped to their own linked employee.
    if (!canManage) {
      if (!self) {
        return NextResponse.json({
          requests: [],
          summary: emptySummary(),
          context: { canManage, self: null, employees: [] },
        })
      }
      add("r.employee_id = ?", self.id)
    } else if (sp.get("employeeId")) {
      add("r.employee_id = ?", Number(sp.get("employeeId")))
    }

    if (sp.get("status")) add("r.status = ?", sp.get("status"))
    if (sp.get("correctionType")) add("r.correction_type = ?", sp.get("correctionType"))
    if (sp.get("department")) add("e.department = ?", sp.get("department"))
    if (sp.get("workFrom")) add("r.work_date >= ?", sp.get("workFrom"))
    if (sp.get("workTo")) add("r.work_date <= ?", sp.get("workTo"))
    const search = sp.get("search")?.trim()
    if (search) add("(r.request_id LIKE ? OR r.employee_name LIKE ? OR e.employee_id LIKE ?)", `%${search}%`, `%${search}%`, `%${search}%`)

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

    const requests = await query<any[]>(
      `SELECT r.*, e.employee_id AS employee_code, e.department AS emp_department,
              e.designation AS emp_designation, e.reporting_manager AS emp_manager,
              a.attendance_id AS linked_attendance_code, a.clock_in AS att_clock_in,
              a.clock_out AS att_clock_out, a.status AS att_status, a.working_hours AS att_hours
       FROM hr_attendance_regularisation r
       JOIN hr_employees e ON e.id = r.employee_id
       LEFT JOIN hr_attendance a ON a.id = r.attendance_id
       ${whereSql}
       ORDER BY r.requested_at DESC, r.id DESC`,
      params,
    )

    const summaryRows = await query<any[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(r.status = 'Pending') AS pending,
         SUM(r.status = 'Approved') AS approved,
         SUM(r.status = 'Rejected') AS rejected,
         SUM(r.status = 'Cancelled') AS cancelled,
         SUM(MONTH(r.requested_at) = MONTH(CURDATE()) AND YEAR(r.requested_at) = YEAR(CURDATE())) AS this_month
       FROM hr_attendance_regularisation r
       JOIN hr_employees e ON e.id = r.employee_id
       ${whereSql}`,
      params,
    )
    const s = summaryRows[0] || {}
    const summary = {
      total: Number(s.total || 0),
      pending: Number(s.pending || 0),
      approved: Number(s.approved || 0),
      rejected: Number(s.rejected || 0),
      cancelled: Number(s.cancelled || 0),
      thisMonth: Number(s.this_month || 0),
    }

    // Employee picker for approvers; self-only users don't need the list.
    let employees: { id: number; employee_name: string; employee_id: string; department: string | null }[] = []
    if (canManage) {
      employees = await query<any[]>(
        "SELECT id, employee_name, employee_id, department FROM hr_employees WHERE archived_at IS NULL ORDER BY employee_name ASC",
      )
    }

    return NextResponse.json({
      requests,
      summary,
      context: {
        canManage,
        self: self ? { id: self.id, employee_name: self.employee_name, employee_id: self.employee_id, department: self.department } : null,
        employees,
        correctionTypes: CORRECTION_TYPES,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load requests" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRegularisationSchema()

    const canManage = await canManageRegularisation(session)
    const body = await request.json().catch(() => ({}))
    const workDate = String(body.work_date || "").slice(0, 10)
    const reason = String(body.reason || "").trim()

    if (!isDate(workDate)) return NextResponse.json({ error: "A valid work date is required." }, { status: 400 })
    if (reason.length < 3) return NextResponse.json({ error: "A meaningful reason is required." }, { status: 400 })

    // Employee resolution: managers may act for anyone; everyone else is pinned
    // to their own linked employee so they can never file for someone else.
    let employee
    if (canManage && body.employee_id) {
      employee = await getEmployeeById(Number(body.employee_id))
    } else {
      employee = await resolveSessionEmployee(session)
    }
    if (!employee) return NextResponse.json({ error: "No employee profile is linked to this account." }, { status: 400 })

    const insight = await buildDayInsight(employee, workDate)

    // Full-day approved leave is contradictory unless an approver overrides.
    if (insight.blocked && !canManage) {
      return NextResponse.json({ error: insight.blocked.reason }, { status: 409 })
    }
    // One active request per employee + date.
    if (insight.pendingExists) {
      return NextResponse.json({ error: "A pending regularisation already exists for this date." }, { status: 409 })
    }

    const requestedClockIn = toDateTime(workDate, body.requested_clock_in)
    const requestedClockOut = toDateTime(workDate, body.requested_clock_out)
    const requestedStatus = body.requested_status ? String(body.requested_status).slice(0, 50) : null

    // Requested values must actually change something.
    const current = insight.attendance
    const changesSomething =
      (requestedClockIn && requestedClockIn !== (current?.clock_in ?? null)) ||
      (requestedClockOut && requestedClockOut !== (current?.clock_out ?? null)) ||
      (requestedStatus && requestedStatus !== (current?.status ?? null))
    if (!changesSomething) {
      return NextResponse.json({ error: "Requested values must differ from the current attendance." }, { status: 400 })
    }

    // Logical ordering (skip for overnight shifts where out < in is legitimate).
    if (requestedClockIn && requestedClockOut && !insight.shift?.is_overnight && new Date(requestedClockOut.replace(" ", "T")) < new Date(requestedClockIn.replace(" ", "T"))) {
      return NextResponse.json({ error: "Requested clock out cannot be before clock in." }, { status: 400 })
    }

    const correctionType = body.correction_type && CORRECTION_TYPES.includes(body.correction_type)
      ? body.correction_type
      : insight.suggestedType

    const requestId = await nextRecordId("REG", { allowCustom: true, digits: 6 })

    await query(
      `INSERT INTO hr_attendance_regularisation
         (request_id, attendance_id, employee_id, employee_name, work_date, correction_type,
          current_clock_in, current_clock_out, current_status,
          requested_clock_in, requested_clock_out, requested_status,
          department, designation, reporting_manager,
          reason, attachment_path, attachment_name, status, requested_by, requested_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Pending', ?, ?)`,
      [
        requestId,
        current?.id ?? null,
        employee.id,
        employee.employee_name,
        workDate,
        correctionType,
        current?.clock_in ?? null,
        current?.clock_out ?? null,
        current?.status ?? null,
        requestedClockIn,
        requestedClockOut,
        requestedStatus,
        employee.department ?? null,
        employee.designation ?? null,
        employee.reporting_manager ?? null,
        reason.slice(0, 2000),
        body.attachment_path || null,
        body.attachment_name ? String(body.attachment_name).slice(0, 255) : null,
        session.userId,
        session.name,
      ],
    )

    await logEmployeeEvent({
      employeeId: employee.id,
      employeeRef: employee.employee_id,
      employeeName: employee.employee_name,
      type: "updated",
      summary: `Regularisation ${requestId} submitted for ${workDate} (${correctionType}) by ${session.name}`,
      actorId: session.userId,
      actorName: session.name,
    })

    return NextResponse.json({ requestId }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create request" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRegularisationSchema()

    const body = await request.json().catch(() => ({}))
    const id = Number(body.id)
    const action = String(body.action || (body.status === "Approved" ? "approve" : body.status === "Rejected" ? "reject" : "")).toLowerCase()
    if (!id || !["approve", "reject", "cancel"].includes(action)) {
      return NextResponse.json({ error: "A valid request id and action are required." }, { status: 400 })
    }

    const rows = await query<any[]>("SELECT * FROM hr_attendance_regularisation WHERE id = ? LIMIT 1", [id])
    const req = rows[0]
    if (!req) return NextResponse.json({ error: "Request not found." }, { status: 404 })
    if (req.status !== "Pending") {
      return NextResponse.json({ error: `This request is already ${String(req.status).toLowerCase()} and cannot be changed.` }, { status: 409 })
    }

    const canManage = await canManageRegularisation(session)
    const self = await resolveSessionEmployee(session)

    // Cancel: only the requester (or a manager) may cancel a pending request.
    if (action === "cancel") {
      const isOwner = self && Number(self.id) === Number(req.employee_id)
      if (!isOwner && !canManage) return NextResponse.json({ error: "You can only cancel your own request." }, { status: 403 })
      await query("UPDATE hr_attendance_regularisation SET status = 'Cancelled', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [session.name, id])
      await logEmployeeEvent({
        employeeId: Number(req.employee_id),
        employeeName: req.employee_name,
        type: "updated",
        summary: `Regularisation ${req.request_id} cancelled by ${session.name}`,
        actorId: session.userId,
        actorName: session.name,
      })
      return NextResponse.json({ ok: true, status: "Cancelled" })
    }

    // Approve / reject require the manage permission.
    if (!canManage) return NextResponse.json({ error: "You do not have permission to review requests." }, { status: 403 })
    // Prevent self-approval.
    if (self && Number(self.id) === Number(req.employee_id)) {
      return NextResponse.json({ error: "You cannot approve or reject your own request." }, { status: 403 })
    }

    if (action === "reject") {
      const rejectionReason = String(body.rejection_reason || "").trim()
      if (rejectionReason.length < 3) return NextResponse.json({ error: "A rejection reason is required." }, { status: 400 })
      await query(
        "UPDATE hr_attendance_regularisation SET status = 'Rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
        [rejectionReason.slice(0, 2000), session.name, id],
      )
      await logEmployeeEvent({
        employeeId: Number(req.employee_id),
        employeeName: req.employee_name,
        type: "updated",
        summary: `Regularisation ${req.request_id} rejected by ${session.name}: ${rejectionReason.slice(0, 180)}`,
        actorId: session.userId,
        actorName: session.name,
      })
      return NextResponse.json({ ok: true, status: "Rejected" })
    }

    // Approve → apply to the real attendance record transactionally.
    const result = await approveAndApply(req, session)
    return NextResponse.json({ ok: true, status: "Approved", ...result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update request" }, { status: 500 })
  }
}
