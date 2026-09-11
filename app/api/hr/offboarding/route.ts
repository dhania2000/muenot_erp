import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { logEmployeeEvent } from "@/lib/hr-employee-events"
import {
  ensureOffboardingSchema,
  logOffboardingEvent,
  parseNoticeDays,
  addDays,
  CLEARANCE_DEPARTMENTS,
  CLOSED_STATUSES,
  OFFBOARDING_STATUSES,
} from "@/lib/hr-offboarding"

// Columns a client may patch inline from the list (kept minimal; the rich
// workflow actions live in the [id] route).
const INLINE_FIELDS = ["exit_type", "notice_date", "last_working_date", "status", "remarks"] as const

const EMPLOYEE_SELECT = `
  e.id AS emp_pk, e.employee_id AS employee_code, e.employee_name, e.department, e.designation,
  e.reporting_manager, e.joining_date, e.employment_type, e.work_mode, e.employment_status,
  e.shift, e.notice_period, e.official_email, e.personal_email, e.user_id`

export async function GET(request: NextRequest) {
  const session = await requireFeature("hr.view_offboarding")
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOffboardingSchema()

  const url = request.nextUrl
  const search = (url.searchParams.get("search") || "").trim()
  const status = url.searchParams.get("status") || ""
  const exitType = url.searchParams.get("exit_type") || ""
  const department = url.searchParams.get("department") || ""
  const settlement = url.searchParams.get("settlement_status") || ""
  const quick = url.searchParams.get("quick") || ""
  const page = Math.max(1, Number(url.searchParams.get("page") || 1))
  const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get("pageSize") || 20)))

  const where: string[] = []
  const params: any[] = []

  if (search) {
    where.push("(e.employee_name LIKE ? OR e.employee_id LIKE ? OR o.offboarding_id LIKE ? OR e.department LIKE ?)")
    const like = `%${search}%`
    params.push(like, like, like, like)
  }
  if (status) {
    where.push("o.status = ?")
    params.push(status)
  }
  if (exitType) {
    where.push("o.exit_type = ?")
    params.push(exitType)
  }
  if (department) {
    where.push("e.department = ?")
    params.push(department)
  }
  if (settlement) {
    where.push("o.settlement_status = ?")
    params.push(settlement)
  }

  // Quick filters map to lifecycle / date conditions.
  const closedList = CLOSED_STATUSES.map(() => "?").join(",")
  if (quick === "active") {
    where.push(`o.status NOT IN (${closedList})`)
    params.push(...CLOSED_STATUSES)
  } else if (quick === "notice") {
    where.push("o.status = 'Notice Period'")
  } else if (quick === "pending_clearance") {
    where.push(
      "EXISTS (SELECT 1 FROM hr_offboarding_clearances c WHERE c.offboarding_id = o.id AND c.is_mandatory = 1 AND c.status NOT IN ('Cleared','Not Applicable'))",
    )
  } else if (quick === "pending_settlement") {
    where.push(`o.settlement_status NOT IN ('Approved','Processed','Completed') AND o.status NOT IN (${closedList})`)
    params.push(...CLOSED_STATUSES)
  } else if (quick === "leaving_week") {
    where.push(
      `COALESCE(o.last_working_date, o.expected_last_working_date) BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND o.status NOT IN (${closedList})`,
    )
    params.push(...CLOSED_STATUSES)
  } else if (quick === "completed") {
    where.push("o.status = 'Completed'")
  } else if (quick === "cancelled") {
    where.push("o.status IN ('Cancelled','Withdrawn')")
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const clearanceSummary = `
    (SELECT COUNT(*) FROM hr_offboarding_clearances c WHERE c.offboarding_id = o.id) AS clearance_total,
    (SELECT COUNT(*) FROM hr_offboarding_clearances c WHERE c.offboarding_id = o.id AND c.status IN ('Cleared','Not Applicable')) AS clearance_done,
    (SELECT COUNT(*) FROM hr_offboarding_assets a WHERE a.offboarding_id = o.id AND a.return_status NOT IN ('Returned','Not Applicable')) AS assets_pending`

  const totalRow = await query<any[]>(
    `SELECT COUNT(*) AS total FROM hr_offboarding o JOIN hr_employees e ON e.id = o.employee_id ${whereSql}`,
    params,
  )
  const total = Number(totalRow[0]?.total || 0)

  const rows = await query<any[]>(
    `SELECT o.*, e.employee_name, e.employee_id AS employee_code, e.department, e.designation,
            e.reporting_manager, ${clearanceSummary}
     FROM hr_offboarding o JOIN hr_employees e ON e.id = o.employee_id
     ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  )

  const metrics = await getMetrics()
  const facets = {
    departments: (
      await query<any[]>(
        "SELECT DISTINCT e.department AS value FROM hr_offboarding o JOIN hr_employees e ON e.id=o.employee_id WHERE e.department IS NOT NULL AND e.department <> '' ORDER BY e.department",
      )
    ).map((r) => r.value),
  }

  return NextResponse.json({ offboarding: rows, total, page, pageSize, metrics, facets, statuses: OFFBOARDING_STATUSES })
}

async function getMetrics() {
  const closedList = CLOSED_STATUSES.map((s) => `'${s}'`).join(",")
  const [row] = await query<any[]>(`
    SELECT
      SUM(CASE WHEN o.status NOT IN (${closedList}) THEN 1 ELSE 0 END) AS active_offboarding,
      SUM(CASE WHEN COALESCE(o.last_working_date, o.expected_last_working_date) BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND o.status NOT IN (${closedList}) THEN 1 ELSE 0 END) AS leaving_this_week,
      SUM(CASE WHEN o.settlement_status NOT IN ('Approved','Processed','Completed') AND o.status NOT IN (${closedList}) THEN 1 ELSE 0 END) AS pending_settlement,
      SUM(CASE WHEN o.status = 'Completed' AND o.completed_at >= DATE_FORMAT(CURDATE(),'%Y-%m-01') THEN 1 ELSE 0 END) AS completed_this_month
    FROM hr_offboarding o`)

  const [clearanceRow] = await query<any[]>(`
    SELECT COUNT(DISTINCT o.id) AS pending_clearance
    FROM hr_offboarding o
    WHERE o.status NOT IN (${closedList})
      AND EXISTS (SELECT 1 FROM hr_offboarding_clearances c WHERE c.offboarding_id = o.id AND c.is_mandatory = 1 AND c.status NOT IN ('Cleared','Not Applicable'))`)

  const [assetRow] = await query<any[]>(`
    SELECT COUNT(DISTINCT o.id) AS pending_assets
    FROM hr_offboarding o
    WHERE o.status NOT IN (${closedList})
      AND EXISTS (SELECT 1 FROM hr_offboarding_assets a WHERE a.offboarding_id = o.id AND a.return_status NOT IN ('Returned','Not Applicable'))`)

  return {
    activeOffboarding: Number(row?.active_offboarding || 0),
    leavingThisWeek: Number(row?.leaving_this_week || 0),
    pendingSettlement: Number(row?.pending_settlement || 0),
    completedThisMonth: Number(row?.completed_this_month || 0),
    pendingClearance: Number(clearanceRow?.pending_clearance || 0),
    pendingAssets: Number(assetRow?.pending_assets || 0),
  }
}

export async function POST(request: NextRequest) {
  const session = await requireFeature("hr.manage_offboarding")
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  await ensureOffboardingSchema()

  const body = await request.json()
  const employeePk = Number(body.employee_id)
  if (!employeePk) return NextResponse.json({ error: "Employee is required" }, { status: 400 })

  const empRows = await query<any[]>(`SELECT ${EMPLOYEE_SELECT} FROM hr_employees e WHERE e.id = ? LIMIT 1`, [employeePk])
  const emp = empRows[0]
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  // Data integrity: at most one active offboarding case per employee.
  const activePlaceholders = CLOSED_STATUSES.map(() => "?").join(",")
  const existing = await query<any[]>(
    `SELECT id, offboarding_id FROM hr_offboarding WHERE employee_id = ? AND status NOT IN (${activePlaceholders}) LIMIT 1`,
    [employeePk, ...CLOSED_STATUSES],
  )
  if (existing.length) {
    return NextResponse.json(
      { error: `An active offboarding case already exists (${existing[0].offboarding_id})` },
      { status: 409 },
    )
  }

  const noticeDate: string | null = body.notice_date || null
  const noticeDays = parseNoticeDays(emp.notice_period)
  const expectedLwd = addDays(noticeDate, noticeDays)
  const requestedLwd: string | null = body.last_working_date || null

  const offboardingId = await nextRecordId("OFF", { allowCustom: true, digits: 6 })

  const result = await query<any>(
    `INSERT INTO hr_offboarding
      (offboarding_id, employee_id, notice_date, notice_period_days, expected_last_working_date, last_working_date,
       exit_type, exit_reason, support_document, remarks, status, settlement_status, exit_interview_status,
       previous_employment_status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      offboardingId,
      employeePk,
      noticeDate,
      noticeDays,
      expectedLwd,
      requestedLwd,
      body.exit_type || null,
      body.exit_reason || null,
      body.support_document || null,
      body.remarks || null,
      "Notice Period",
      "Not Started",
      "Pending",
      emp.employment_status || null,
      session.userId,
    ],
  )
  const caseId = Number(result.insertId)

  // Auto-generate the clearance checklist so HR doesn't create each task by hand.
  const clearanceValues = CLEARANCE_DEPARTMENTS.map((dept, i) => [
    caseId,
    dept,
    dept === "Reporting Manager" ? emp.reporting_manager || null : null,
    "Pending",
    1,
    i,
  ])
  await query(
    `INSERT INTO hr_offboarding_clearances (offboarding_id, department, responsible_name, status, is_mandatory, sort_order)
     VALUES ${clearanceValues.map(() => "(?,?,?,?,?,?)").join(",")}`,
    clearanceValues.flat(),
  )

  // Move the employee to Notice Period using the existing status architecture.
  await query("UPDATE hr_employees SET employment_status = 'Notice Period', status_changed_at = NOW() WHERE id = ?", [
    employeePk,
  ])

  await logEmployeeEvent({
    employeeId: employeePk,
    employeeRef: emp.employee_code,
    employeeName: emp.employee_name,
    type: "status_changed",
    summary: `Offboarding initiated (${offboardingId}) — moved to Notice Period`,
    changes: [{ field: "employment_status", label: "Status", from: emp.employment_status, to: "Notice Period" }],
    actorId: session.userId,
    actorName: session.name,
  })
  await logOffboardingEvent({
    offboardingId: caseId,
    employeeId: employeePk,
    eventType: "initiated",
    summary: `Exit initiated (${body.exit_type || "Exit"})`,
    details: { exit_type: body.exit_type, notice_date: noticeDate, expected_last_working_date: expectedLwd },
    actorId: session.userId,
    actorName: session.name,
  })

  return NextResponse.json({ offboarding_id: offboardingId, id: caseId }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await requireFeature("hr.manage_offboarding")
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  await ensureOffboardingSchema()

  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "ID is required" }, { status: 400 })

  const updates = INLINE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f))
  if (!updates.length) return NextResponse.json({ error: "No changes provided" }, { status: 400 })

  const rows = await query<any[]>("SELECT * FROM hr_offboarding WHERE id = ? LIMIT 1", [body.id])
  const current = rows[0]
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await query(
    `UPDATE hr_offboarding SET ${updates.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`,
    [...updates.map((f) => body[f]), body.id],
  )

  const changed = updates.filter((f) => String(current[f] ?? "") !== String(body[f] ?? ""))
  if (changed.length) {
    await logOffboardingEvent({
      offboardingId: Number(body.id),
      employeeId: current.employee_id,
      eventType: "updated",
      summary: `Updated ${changed.join(", ")}`,
      details: Object.fromEntries(changed.map((f) => [f, { from: current[f] ?? null, to: body[f] ?? null }])),
      actorId: session.userId,
      actorName: session.name,
    })
  }

  return NextResponse.json({ ok: true })
}
