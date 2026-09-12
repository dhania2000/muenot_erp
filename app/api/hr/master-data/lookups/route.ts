import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// HR Master Data — lightweight lookup endpoint.
//
// Powers the cross-module selectors (employee / department / designation /
// document-type pickers) and the promotion auto-fill. It returns only the
// minimal id + display fields a dropdown needs — never full master records —
// so a selector never drags down a heavy payload (spec §79).
//
//   GET ?kind=employees|departments|designations|document-types[&q=...]
//   GET ?kind=employee-context&employeeId=123   -> current dept/designation/grade
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const kind = req.nextUrl.searchParams.get("kind") || ""
  const q = (req.nextUrl.searchParams.get("q") || "").trim()
  const like = `%${q}%`

  if (kind === "employees") {
    const rows = await query(
      `SELECT id, employee_id, employee_name, department, designation, employee_grade, employment_status
       FROM hr_employees
       WHERE (? = '' OR employee_name LIKE ? OR employee_id LIKE ?)
       ORDER BY employee_name ASC LIMIT 50`,
      [q, like, like],
    )
    return NextResponse.json({ rows })
  }

  if (kind === "departments") {
    const rows = await query(
      `SELECT department_id, department_name, status
       FROM hr_departments
       WHERE (? = '' OR department_name LIKE ? OR department_id LIKE ?)
       ORDER BY department_name ASC LIMIT 200`,
      [q, like, like],
    )
    return NextResponse.json({ rows })
  }

  if (kind === "designations") {
    const rows = await query(
      `SELECT designation_id, designation_name, level_name, status
       FROM hr_designations
       WHERE (? = '' OR designation_name LIKE ? OR designation_id LIKE ?)
       ORDER BY designation_name ASC LIMIT 200`,
      [q, like, like],
    )
    return NextResponse.json({ rows })
  }

  if (kind === "document-types") {
    const rows = await query(
      `SELECT id, type_name, is_required, has_expiry, status
       FROM hr_document_types
       WHERE status = 'Active' AND (? = '' OR type_name LIKE ?)
       ORDER BY sort_order ASC, type_name ASC`,
      [q, like],
    )
    return NextResponse.json({ rows })
  }

  if (kind === "employee-context") {
    const employeeId = req.nextUrl.searchParams.get("employeeId") || ""
    const rows = await query<any[]>(
      `SELECT id, employee_id, employee_name, department, designation, reporting_manager, employee_grade
       FROM hr_employees WHERE id = ? OR employee_id = ? LIMIT 1`,
      [Number(employeeId) || 0, employeeId],
    )
    if (!rows.length) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
    const e = rows[0]
    // Resolve the employee's free-text department/designation names back to the
    // master IDs so a promotion can store proper references for its "old" values.
    const dept = await query<any[]>(
      "SELECT department_id FROM hr_departments WHERE department_name = ? LIMIT 1",
      [e.department],
    )
    const desg = await query<any[]>(
      "SELECT designation_id FROM hr_designations WHERE designation_name = ? LIMIT 1",
      [e.designation],
    )
    return NextResponse.json({
      employee: {
        id: e.id,
        employee_id: e.employee_id,
        employee_name: e.employee_name,
        department: e.department,
        designation: e.designation,
        reporting_manager: e.reporting_manager,
        grade: e.employee_grade,
        old_department_id: dept[0]?.department_id ?? null,
        old_designation_id: desg[0]?.designation_id ?? null,
      },
    })
  }

  return NextResponse.json({ error: "Invalid kind" }, { status: 400 })
}
