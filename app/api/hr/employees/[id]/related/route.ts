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
    "SELECT id, employee_name, user_id FROM hr_employees WHERE id = ? LIMIT 1",
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

  return NextResponse.json({
    documents,
    attendance,
    leaves,
    tickets,
    counts: {
      documents: documents.length,
      attendance: attendance.length,
      leaves: leaves.length,
      tickets: tickets.length,
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
