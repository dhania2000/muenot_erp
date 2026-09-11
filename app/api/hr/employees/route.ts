import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { ensureEmployeeEventsSchema, logEmployeeEvent } from "@/lib/hr-employee-events"
import { initializeEmployeeBalances } from "@/lib/hr-leave"

// Columns that can be written via create/update.
const ALLOWED = new Set([
  "employee_id","employee_name","gender","dob","personal_email","official_email","mobile","alternate_mobile","address","city","state","country","postal_code","emergency_contact_name","emergency_contact_phone","emergency_contact_relation","relative_name","relative_relationship","relative_primary_phone","relative_alternate_phone","relative_email","relative_address","department","designation","reporting_manager","employment_type","joining_date","probation_end_date","confirmation_date","employment_status","onboarding_status","work_location","work_mode","shift","employee_grade","document_status","agreement_status","consent_status","compliance_status","it_access_status","asset_status","training_status","performance_status","notice_period","notice_period_status","exit_status","exit_date","exit_reason","skills","notes","bank_account_holder_name","bank_name","bank_account_number","bank_ifsc_code","bank_branch","bank_account_type","bank_swift_code","bank_pan_number","bank_upi_id","photo_url",
])

// Whitelist of sortable columns → SQL expression (prevents injection).
const SORTABLE: Record<string, string> = {
  name: "employee_name",
  employee_id: "employee_id",
  department: "department",
  designation: "designation",
  employment_status: "employment_status",
  joining_date: "joining_date",
  created_at: "created_at",
  updated_at: "updated_at",
}

const FACET_COLUMNS = [
  "department",
  "designation",
  "employment_type",
  "work_mode",
  "work_location",
  "employment_status",
  "reporting_manager",
  "gender",
] as const

export async function GET(request: Request) {
  const session = await requireFeature("hr.view_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const url = new URL(request.url)
  const sp = url.searchParams

  const where: string[] = []
  const args: any[] = []

  // Soft-archive scope: active (default) | archived | all.
  const archived = sp.get("archived") || "active"
  if (archived === "active") where.push("archived_at IS NULL")
  else if (archived === "archived") where.push("archived_at IS NOT NULL")

  // Free-text search across the most-used identifying fields.
  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push(
      "(employee_name LIKE ? OR employee_id LIKE ? OR official_email LIKE ? OR personal_email LIKE ? OR mobile LIKE ? OR department LIKE ? OR designation LIKE ?)",
    )
    args.push(like, like, like, like, like, like, like)
  }

  // Exact-match column filters.
  const columnFilters: Record<string, string> = {
    employment_status: "status",
    department: "department",
    designation: "designation",
    employment_type: "employment_type",
    work_mode: "work_mode",
    work_location: "work_location",
    reporting_manager: "reporting_manager",
    gender: "gender",
    onboarding_status: "onboarding_status",
  }
  for (const [column, param] of Object.entries(columnFilters)) {
    const value = sp.get(param)
    if (value) {
      where.push(`${column} = ?`)
      args.push(value)
    }
  }

  // Joining-date range.
  const joiningFrom = sp.get("joining_from")
  const joiningTo = sp.get("joining_to")
  if (joiningFrom) {
    where.push("joining_date >= ?")
    args.push(joiningFrom)
  }
  if (joiningTo) {
    where.push("joining_date <= ?")
    args.push(joiningTo)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  // Sorting.
  const sortKey = sp.get("sort") || "created_at"
  const sortColumn = SORTABLE[sortKey] || "created_at"
  const dir = (sp.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC"

  // Total count for the current filter set.
  const countRows = await query<{ total: number }[]>(
    `SELECT COUNT(*) AS total FROM hr_employees ${whereSql}`,
    args,
  )
  const total = Number(countRows[0]?.total || 0)

  // Pagination is opt-in: callers that don't pass `page` get the full set
  // (preserves existing dropdown/consumer behaviour).
  const pageParam = sp.get("page")
  let employees: any[]
  let page = 1
  let pageSize = total
  if (pageParam) {
    page = Math.max(1, Number(pageParam) || 1)
    pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 25))
    const offset = (page - 1) * pageSize
    employees = await query<any[]>(
      `SELECT * FROM hr_employees ${whereSql} ORDER BY ${sortColumn} ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    )
  } else {
    employees = await query<any[]>(
      `SELECT * FROM hr_employees ${whereSql} ORDER BY ${sortColumn} ${dir}, id ${dir}`,
      args,
    )
  }

  // Facets: distinct values (over the active scope) so filter dropdowns are populated.
  const facets: Record<string, string[]> = {}
  if (sp.get("facets") !== "0") {
    const facetScope = archived === "archived" ? "archived_at IS NOT NULL" : archived === "all" ? "1=1" : "archived_at IS NULL"
    for (const column of FACET_COLUMNS) {
      const rows = await query<{ value: string }[]>(
        `SELECT DISTINCT ${column} AS value FROM hr_employees WHERE ${facetScope} AND ${column} IS NOT NULL AND ${column} <> '' ORDER BY ${column} ASC LIMIT 200`,
      )
      facets[column] = rows.map((r) => r.value)
    }
  }

  return NextResponse.json({ employees, total, page, pageSize, facets })
}

export async function POST(request: Request) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()
  const body = await request.json()
  if (!body.employee_name) return NextResponse.json({ error: "Employee name is required" }, { status: 400 })
  const employeeId = await nextRecordId("EMP")
  const fields = Object.keys(body).filter((key) => ALLOWED.has(key) && key !== "employee_id")
  fields.unshift("employee_id")
  const values = fields.map((key) => (key === "employee_id" ? employeeId : body[key] === "" ? null : body[key]))
  const result = await query<any>(
    `INSERT INTO hr_employees (${fields.join(",")},created_by) VALUES (${fields.map(() => "?").join(",")},?)`,
    [...values, session.userId],
  )

  await logEmployeeEvent({
    employeeId: Number(result.insertId),
    employeeRef: employeeId,
    employeeName: String(body.employee_name),
    type: "created",
    summary: `Employee ${body.employee_name} (${employeeId}) created`,
    actorId: session.userId,
    actorName: session.name,
  })

  // Auto-initialize this year's leave balances for the new hire (best-effort:
  // a leave-engine hiccup must never fail employee creation).
  try {
    await initializeEmployeeBalances(Number(result.insertId), new Date().getFullYear(), {
      userId: session.userId,
      name: session.name,
      email: session.email,
      role: session.role,
    })
  } catch (error) {
    console.log("[v0] employee auto-init leave balances failed", (error as Error).message)
  }

  return NextResponse.json({ ok: true, id: result.insertId, employee_id: employeeId }, { status: 201 })
}
