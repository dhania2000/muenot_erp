import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { nextRecordId } from "@/lib/record-ids"
import {
  ensureLeaveSchema,
  getEmployeeByEmail,
  applyAdjustment,
  balanceStatus,
  type Actor,
} from "@/lib/hr-leave"

/** True when the session may see/act on every employee's balances. */
async function resolvePrivilege(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_leave_balances")
}

const SORTABLE = new Set(["employee", "leave_type", "year", "available", "used", "pending", "last_updated"])

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage = await resolvePrivilege(session)
  const self = canManage ? null : await getEmployeeByEmail(session.email)
  if (!canManage && !self) {
    return NextResponse.json({
      balances: [], summary: emptySummary(), canManage, years: [new Date().getFullYear()], departments: [],
    })
  }

  const sp = new URL(request.url).searchParams
  const year = Number(sp.get("year")) || new Date().getFullYear()

  const where: string[] = ["b.`year` = ?"]
  const args: any[] = [year]

  if (!canManage && self) {
    where.push("b.employee_id = ?")
    args.push(self.id)
  }

  const department = sp.get("department")
  if (department && department !== "all" && canManage) {
    where.push("e.department = ?")
    args.push(department)
  }

  const leaveType = sp.get("leave_type")
  if (leaveType && leaveType !== "all") {
    where.push("lt.leave_type_id = ?")
    args.push(leaveType)
  }

  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push("(e.employee_name LIKE ? OR e.employee_id LIKE ? OR lt.leave_type LIKE ?)")
    args.push(like, like, like)
  }

  const rows = await query<any[]>(
    `SELECT b.*, e.employee_name, e.employee_id AS employee_code, e.department, e.designation,
            e.reporting_manager, e.employment_status,
            lt.leave_type, lt.leave_type_id AS leave_type_code, lt.annual_quota, lt.paid,
            lt.low_balance_threshold, lt.carry_forward AS max_carry_forward
     FROM hr_leave_balances b
     JOIN hr_employees e ON e.id = b.employee_id
     JOIN hr_leave_types lt ON lt.id = b.leave_type_id
     WHERE ${where.join(" AND ")}`,
    args,
  )

  // Compute health status server-side, then filter/sort in memory.
  const enriched = rows.map((r) => ({
    ...r,
    available: Number(r.available),
    status: balanceStatus(Number(r.available), { low_balance_threshold: r.low_balance_threshold, annual_quota: r.annual_quota }),
  }))

  const summary = {
    employees: new Set(enriched.map((r) => r.employee_id)).size,
    totalAvailable: round(enriched.reduce((s, r) => s + Number(r.available), 0)),
    totalUsed: round(enriched.reduce((s, r) => s + Number(r.used), 0)),
    totalPending: round(enriched.reduce((s, r) => s + Number(r.pending), 0)),
    lowBalance: enriched.filter((r) => r.status === "Low Balance").length,
    zeroBalance: enriched.filter((r) => r.status === "Zero Balance").length,
  }

  const statusFilter = sp.get("status")
  let result = enriched
  if (statusFilter && statusFilter !== "all") {
    result = result.filter((r) => r.status === statusFilter)
  }

  const sort = SORTABLE.has(sp.get("sort") || "") ? (sp.get("sort") as string) : "employee"
  const dir = (sp.get("dir") || "asc").toLowerCase() === "desc" ? -1 : 1
  result.sort((a, b) => dir * compareBy(a, b, sort))

  // Facets for the filter controls (management scope only).
  let departments: string[] = []
  let years: number[] = []
  if (canManage) {
    const deptRows = await query<{ department: string }[]>(
      `SELECT DISTINCT e.department FROM hr_leave_balances b JOIN hr_employees e ON e.id = b.employee_id
       WHERE e.department IS NOT NULL AND e.department <> '' ORDER BY e.department`,
    )
    departments = deptRows.map((r) => r.department)
  }
  const yearRows = await query<{ year: number }[]>(
    `SELECT DISTINCT \`year\` AS year FROM hr_leave_balances ORDER BY \`year\` DESC`,
  )
  years = yearRows.map((r) => Number(r.year))
  if (!years.includes(year)) years.unshift(year)
  if (!years.length) years = [new Date().getFullYear()]

  return NextResponse.json({ balances: result, summary, canManage, years, departments })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage = await resolvePrivilege(session)
  if (!canManage) return NextResponse.json({ error: "You do not have permission to adjust leave balances." }, { status: 403 })

  const body = await request.json()
  const employeeId = Number(body.employee_id)
  const year = Number(body.year)
  const days = Number(body.days)
  if (!employeeId || !body.leave_type_id || !year) {
    return NextResponse.json({ error: "Employee, leave type and year are required." }, { status: 400 })
  }
  if (!Number.isFinite(days) || days === 0) {
    return NextResponse.json({ error: "Enter a non-zero adjustment (use a negative value to deduct)." }, { status: 400 })
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
    console.log("[v0] leave adjustment failed", (error as Error).message)
    return NextResponse.json({ error: "Could not apply the adjustment." }, { status: 500 })
  }
}

function emptySummary() {
  return { employees: 0, totalAvailable: 0, totalUsed: 0, totalPending: 0, lowBalance: 0, zeroBalance: 0 }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}

function compareBy(a: any, b: any, key: string): number {
  switch (key) {
    case "leave_type":
      return String(a.leave_type).localeCompare(String(b.leave_type))
    case "year":
      return Number(a.year) - Number(b.year)
    case "available":
      return Number(a.available) - Number(b.available)
    case "used":
      return Number(a.used) - Number(b.used)
    case "pending":
      return Number(a.pending) - Number(b.pending)
    case "last_updated":
      return String(a.last_updated || "").localeCompare(String(b.last_updated || ""))
    default:
      return String(a.employee_name).localeCompare(String(b.employee_name))
  }
}
