import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { nextRecordId } from "@/lib/record-ids"
import { ensureLeaveSchema, getEmployeeByEmail, applyAdjustment, type Actor } from "@/lib/hr-leave"

const FEATURE = "hr.view_leave_quota_history"

/** Management scope: may view/act on every employee's ledger. */
async function canManage(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, FEATURE)
}

const SORT_COLUMNS: Record<string, string> = {
  created_at: "h.created_at",
  employee: "e.employee_name",
  leave_type: "lt.leave_type",
  year: "h.`year`",
  event_type: "h.event_type",
  days: "h.days",
}

// Quick-filter groups map to one or more stored event_type values.
const EVENT_GROUPS: Record<string, string[]> = {
  accrual: ["accrual"],
  leave_used: ["leave_approved"],
  adjustment: ["adjustment"],
  carry_forward: ["carry_forward"],
  expiry: ["expiry"],
  reversal: ["reversal", "leave_reversed"],
  opening: ["opening"],
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const manage = await canManage(session)
  const self = manage ? null : await getEmployeeByEmail(session.email)
  if (!manage && !self) {
    return NextResponse.json({
      events: [], total: 0, page: 1, pageSize: 25, canManage: false,
      summary: emptySummary(), years: [new Date().getFullYear()], departments: [],
    })
  }

  const sp = new URL(request.url).searchParams
  const where: string[] = []
  const args: any[] = []

  if (!manage && self) {
    where.push("h.employee_id = ?")
    args.push(self.id)
  }

  const year = sp.get("year")
  if (year && year !== "all") {
    where.push("h.`year` = ?")
    args.push(Number(year))
  }

  if (manage) {
    const employee = sp.get("employee")
    if (employee && employee !== "all") {
      where.push("h.employee_id = ?")
      args.push(Number(employee))
    }
    const department = sp.get("department")
    if (department && department !== "all") {
      where.push("e.department = ?")
      args.push(department)
    }
  }

  const leaveType = sp.get("leave_type")
  if (leaveType && leaveType !== "all") {
    where.push("(lt.leave_type_id = ? OR CAST(lt.id AS CHAR) = ?)")
    args.push(leaveType, leaveType)
  }

  const eventGroup = sp.get("event")
  if (eventGroup && eventGroup !== "all" && EVENT_GROUPS[eventGroup]) {
    const values = EVENT_GROUPS[eventGroup]
    where.push(`h.event_type IN (${values.map(() => "?").join(",")})`)
    args.push(...values)
  }

  const from = sp.get("from")
  if (from) {
    where.push("h.created_at >= ?")
    args.push(`${from} 00:00:00`)
  }
  const to = sp.get("to")
  if (to) {
    where.push("h.created_at <= ?")
    args.push(`${to} 23:59:59`)
  }

  const reference = sp.get("reference")
  if (reference) {
    where.push("h.reference = ?")
    args.push(reference)
  }

  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push("(h.quota_event_id LIKE ? OR e.employee_name LIKE ? OR e.employee_id LIKE ? OR h.reference LIKE ?)")
    args.push(like, like, like, like)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const sortKey = SORT_COLUMNS[sp.get("sort") || "created_at"] ? (sp.get("sort") as string) : "created_at"
  const orderCol = SORT_COLUMNS[sortKey]
  const dir = (sp.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC"

  const page = Math.max(1, Number(sp.get("page")) || 1)
  const pageSize = Math.min(200, Math.max(5, Number(sp.get("pageSize")) || 25))
  const offset = (page - 1) * pageSize

  const base = `FROM hr_leave_quota_history h
     JOIN hr_employees e ON e.id = h.employee_id
     LEFT JOIN hr_leave_types lt ON lt.id = h.leave_type_id
     ${whereSql}`

  const [countRow] = await query<{ total: number }[]>(`SELECT COUNT(*) AS total ${base}`, args)
  const total = Number(countRow?.total || 0)

  const events = await query<any[]>(
    `SELECT h.event_id, h.quota_event_id, h.employee_id, h.leave_type_id, h.\`year\`,
            h.event_type, h.days, h.reference, h.reason, h.source, h.reversal_of,
            h.created_at, h.created_by,
            e.employee_name, e.employee_id AS employee_code, e.department, e.designation,
            lt.leave_type, lt.leave_type_id AS leave_type_code,
            u.name AS created_by_name,
            rev.quota_event_id AS reversed_by
     ${base}
     LEFT JOIN users u ON u.id = h.created_by
     LEFT JOIN hr_leave_quota_history rev ON rev.reversal_of = h.quota_event_id
     ORDER BY ${orderCol} ${dir}, h.event_id ${dir}
     LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )

  // Summary over the whole filtered set (not just the current page).
  const [summaryRow] = await query<any[]>(
    `SELECT
        COUNT(*) AS transactions,
        COALESCE(SUM(CASE WHEN h.event_type = 'leave_approved' THEN -h.days ELSE 0 END), 0) AS leave_used,
        COALESCE(SUM(CASE WHEN h.event_type = 'accrual' THEN h.days ELSE 0 END), 0) AS accrued,
        COALESCE(SUM(CASE WHEN h.event_type = 'adjustment' THEN h.days ELSE 0 END), 0) AS adjustments,
        COALESCE(SUM(CASE WHEN h.event_type = 'carry_forward' THEN h.days ELSE 0 END), 0) AS carry_forward,
        COALESCE(SUM(CASE WHEN h.event_type IN ('reversal','leave_reversed') THEN 1 ELSE 0 END), 0) AS reversals
     ${base}`,
    args,
  )
  const summary = {
    transactions: Number(summaryRow?.transactions || 0),
    leaveUsed: round(Number(summaryRow?.leave_used || 0)),
    accrued: round(Number(summaryRow?.accrued || 0)),
    adjustments: round(Number(summaryRow?.adjustments || 0)),
    carryForward: round(Number(summaryRow?.carry_forward || 0)),
    reversals: Number(summaryRow?.reversals || 0),
  }

  // Facets for filter controls.
  const yearRows = await query<{ year: number }[]>(
    `SELECT DISTINCT \`year\` AS year FROM hr_leave_quota_history ORDER BY \`year\` DESC`,
  )
  let years = yearRows.map((r) => Number(r.year))
  if (!years.length) years = [new Date().getFullYear()]

  let departments: string[] = []
  if (manage) {
    const deptRows = await query<{ department: string }[]>(
      `SELECT DISTINCT e.department FROM hr_employees e
       WHERE e.department IS NOT NULL AND e.department <> '' ORDER BY e.department`,
    )
    departments = deptRows.map((r) => r.department)
  }

  return NextResponse.json({ events, total, page, pageSize, canManage: manage, summary, years, departments })
}

/**
 * The only manual write path: a controlled balance adjustment. Normal leave
 * activity (used / accrual / carry-forward / expiry) is generated automatically
 * from its source transaction and can never be hand-posted here.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  if (!(await canManage(session))) {
    return NextResponse.json({ error: "You do not have permission to adjust leave quota." }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const employeeId = Number(body.employee_id)
  const year = Number(body.year)
  let days = Number(body.days)

  // A direction toggle keeps the sign in business logic, never in raw user input.
  const direction = String(body.direction || "").toLowerCase()
  if (direction === "debit") days = -Math.abs(days)
  else if (direction === "credit") days = Math.abs(days)

  if (!employeeId || !body.leave_type_id || !year) {
    return NextResponse.json({ error: "Employee, leave type and year are required." }, { status: 400 })
  }
  if (!Number.isFinite(days) || days === 0) {
    return NextResponse.json({ error: "Enter a non-zero number of days." }, { status: 400 })
  }
  if (!body.reason || !String(body.reason).trim()) {
    return NextResponse.json({ error: "A reason is required for every adjustment." }, { status: 400 })
  }

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  const adjustmentId = await nextRecordId("LADJ", { digits: 6 })
  try {
    const result = await applyAdjustment(
      { employeeId, leaveTypeId: body.leave_type_id, year, days, reason: String(body.reason) },
      actor,
      adjustmentId,
    )
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 })
    return NextResponse.json({ ok: true, adjustment_id: result.adjustmentId }, { status: 201 })
  } catch (error) {
    console.log("[v0] leave quota adjustment failed", (error as Error).message)
    return NextResponse.json({ error: "Could not apply the adjustment." }, { status: 500 })
  }
}

function emptySummary() {
  return { transactions: 0, leaveUsed: 0, accrued: 0, adjustments: 0, carryForward: 0, reversals: 0 }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}
