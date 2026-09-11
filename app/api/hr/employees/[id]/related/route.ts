import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

// Aggregates cross-module records for the 360° employee profile. Linkage
// differs per table: documents/attendance are keyed by hr_employees.id, while
// leave requests and support tickets store the employee name. Every query is
// best-effort and read-only — a missing table never breaks the response.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.view_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const empRows = await query<any[]>(
    "SELECT id, employee_name, user_id, reporting_manager, shift FROM hr_employees WHERE id = ? LIMIT 1",
    [id],
  )
  const emp = empRows[0]
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  const name = emp.employee_name

  const documents = await safe(() =>
    query<any[]>(
      `SELECT id, document_type, file_name, status, verified, created_at
         FROM hr_employee_documents WHERE employee_id = ? ORDER BY created_at DESC LIMIT 25`,
      [id],
    ),
  )

  const attendance = await safe(() =>
    query<any[]>(
      `SELECT id, work_date, status, working_hours, clock_in, clock_out
         FROM hr_attendance WHERE employee_id = ? ORDER BY work_date DESC LIMIT 15`,
      [id],
    ),
  )

  const leaves = await safe(() =>
    query<any[]>(
      `SELECT id, request_id, leave_type_id, from_date, to_date, days, status, requested_at
         FROM hr_leave_requests WHERE employee_name = ? ORDER BY requested_at DESC LIMIT 15`,
      [name],
    ),
  )

  const tickets = await safe(() =>
    query<any[]>(
      `SELECT id, ticket_id, support_category, subject, priority, status, created_at
         FROM hr_support_tickets WHERE employee_name = ? ORDER BY created_at DESC LIMIT 15`,
      [name],
    ),
  )

  // Reporting hierarchy is derived from the existing reporting_manager column,
  // so no separate manager table is needed. Manager is matched by name; direct
  // reports are the active employees who report to this person.
  const managerRows = emp.reporting_manager
    ? await safe(() =>
        query<any[]>(
          `SELECT id, employee_id, employee_name, designation, department, official_email
             FROM hr_employees WHERE employee_name = ? AND archived_at IS NULL LIMIT 1`,
          [emp.reporting_manager],
        ),
      )
    : []
  const manager = managerRows[0] || null

  const directReports = await safe(() =>
    query<any[]>(
      `SELECT id, employee_id, employee_name, designation, department, employment_status, official_email
         FROM hr_employees WHERE reporting_manager = ? AND archived_at IS NULL
         ORDER BY employee_name ASC LIMIT 100`,
      [name],
    ),
  )

  // Shift assignment: the employee's shift name resolved against the shift master.
  const shift = emp.shift
    ? (await safe(() =>
        query<any[]>(
          `SELECT shift_id, shift_name, start_time, end_time, break_minutes, working_hours, status
             FROM hr_shifts WHERE shift_name = ? OR shift_id = ? LIMIT 1`,
          [emp.shift, emp.shift],
        ),
      ))[0] || { shift_name: emp.shift }
    : null

  return NextResponse.json({
    documents,
    attendance,
    leaves,
    tickets,
    manager,
    directReports,
    shift,
    reportingManagerName: emp.reporting_manager || null,
    counts: {
      documents: documents.length,
      attendance: attendance.length,
      leaves: leaves.length,
      tickets: tickets.length,
      directReports: directReports.length,
    },
  })
}

// Swallow "table doesn't exist" / permission issues so one missing module
// doesn't blank out the whole profile.
async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn()
  } catch {
    return []
  }
}
