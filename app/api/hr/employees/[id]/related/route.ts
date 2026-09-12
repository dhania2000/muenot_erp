import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { getDocumentTypes, expiryStatus } from "@/lib/hr-documents"
import {
  ensureShiftAssignmentSchema,
  getApplicableShift,
  getUpcomingAssignment,
  deriveState,
} from "@/lib/hr-shift-assignments"

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

  // Only the current, non-archived version of each document is surfaced on the
  // profile so the compliance summary reflects the live state (history and
  // archived docs remain available in the Employee Documents module itself).
  const documents = await safe(() =>
    query<any[]>(
      `SELECT id, document_ref, document_type, document_number, file_name, file_path,
              status, verified, issue_date, expiry_date, version, created_at
         FROM hr_employee_documents
         WHERE employee_id = ? AND is_current = 1 AND archived_at IS NULL
         ORDER BY created_at DESC LIMIT 50`,
      [id],
    ),
  )

  // Compliance summary + required-document checklist, both derived from the
  // hr_document_types master so they stay in sync with HR Master Data.
  const docTypes = await safe(() => getDocumentTypes())
  const warnByName = new Map(docTypes.map((t: any) => [t.type_name, t.expiry_warn_days]))
  const docsWithExpiry = documents.map((d) => ({
    ...d,
    expiry_status: expiryStatus(d.expiry_date, warnByName.get(d.document_type)),
  }))
  const requiredTypes = docTypes.filter((t: any) => t.is_required === 1)
  const documentChecklist = requiredTypes.map((t: any) => {
    const doc = docsWithExpiry.find((d) => d.document_type === t.type_name)
    return { type: t.type_name, uploaded: !!doc, verified: !!doc && doc.status === "Verified" }
  })
  const documentSummary = {
    total: docsWithExpiry.length,
    verified: docsWithExpiry.filter((d) => d.status === "Verified").length,
    pending: docsWithExpiry.filter((d) => d.status === "Pending" || d.status === "Pending Verification").length,
    rejected: docsWithExpiry.filter((d) => d.status === "Rejected").length,
    expiringSoon: docsWithExpiry.filter((d) => d.expiry_status === "Expiring Soon").length,
    expired: docsWithExpiry.filter((d) => d.expiry_status === "Expired").length,
    requiredTotal: requiredTypes.length,
    missingRequired: documentChecklist.filter((c) => !c.uploaded).length,
  }

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

  // Authoritative shift-assignment view (§22): the currently applicable shift
  // resolved through the central resolver, the next upcoming assignment, and
  // the full preserved history. All read from Shift Assignments — never
  // duplicated. Best-effort so a legacy database still renders the profile.
  const today = new Date().toISOString().slice(0, 10)
  await safe(async () => {
    await ensureShiftAssignmentSchema()
    return []
  })
  const currentShift = await (async () => {
    try {
      return await getApplicableShift({ id: Number(id), shift: emp.shift ?? null }, today)
    } catch {
      return null
    }
  })()
  const upcomingAssignment = await (async () => {
    try {
      return await getUpcomingAssignment(Number(id), today)
    } catch {
      return null
    }
  })()
  const assignmentHistoryRaw = await safe(() =>
    query<any[]>(
      `SELECT a.assignment_id, a.effective_from, a.effective_to, a.status, a.change_type,
              a.source_type, a.assigned_by_name, a.notes,
              s.shift_name, s.shift_code, s.start_time, s.end_time, s.is_overnight
         FROM hr_shift_assignments a
         LEFT JOIN hr_shifts s ON s.id = a.shift_id
        WHERE a.employee_id = ?
        ORDER BY a.effective_from DESC, a.id DESC LIMIT 100`,
      [id],
    ),
  )
  const assignmentHistory = assignmentHistoryRaw.map((r) => ({ ...r, derived_state: deriveState(r, today) }))
  const shiftAssignment = { current: currentShift, upcoming: upcomingAssignment, history: assignmentHistory }

  return NextResponse.json({
    documents: docsWithExpiry,
    documentSummary,
    documentChecklist,
    attendance,
    leaves,
    tickets,
    manager,
    directReports,
    shift,
    shiftAssignment,
    reportingManagerName: emp.reporting_manager || null,
    counts: {
      documents: docsWithExpiry.length,
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
