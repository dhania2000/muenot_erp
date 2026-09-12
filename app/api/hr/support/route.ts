import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import {
  ensureSupportSchema,
  canManageSupport,
  canViewSensitive,
  resolveSessionEmployee,
  getCategoryBySlugOrName,
  computeSla,
  nextTicketId,
  logSupportEvent,
  addSupportMessage,
  nowZoned,
  resolutionSlaState,
  PRIORITIES,
  type Priority,
} from "@/lib/hr-support"
import { emitHrEmailEvent } from "@/lib/hr-email-automation"

// ---------------------------------------------------------------------------
// GET  /api/hr/support   — paginated, filtered, visibility-scoped ticket list
//                           plus KPI aggregates for the dashboard header.
// POST /api/hr/support   — create a ticket; employee/department/manager/SLA are
//                           all derived automatically from the ERP.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()

  const manage = await canManageSupport(session)
  const sensitive = await canViewSensitive(session)
  const sp = request.nextUrl.searchParams

  const where: string[] = []
  const params: unknown[] = []

  // Visibility: agents see everything; everyone else only their own tickets
  // (raised by them OR belonging to their linked employee record).
  if (!manage) {
    const employee = await resolveSessionEmployee(session)
    where.push("(t.created_by_user_id = ? OR t.employee_id = ?)")
    params.push(session.userId, employee?.id ?? -1)
  }
  // Hide sensitive tickets from agents without the sensitive-view feature.
  if (manage && !sensitive) where.push("t.is_sensitive = 0")

  if (sp.get("status")) { where.push("t.status = ?"); params.push(sp.get("status")) }
  if (sp.get("priority")) { where.push("t.priority = ?"); params.push(sp.get("priority")) }
  if (sp.get("category")) { where.push("t.support_category = ?"); params.push(sp.get("category")) }
  if (sp.get("assignee")) { where.push("t.assigned_to = ?"); params.push(Number(sp.get("assignee"))) }
  if (sp.get("q")) {
    const like = `%${sp.get("q")}%`
    where.push("(t.ticket_id LIKE ? OR t.subject LIKE ? OR t.employee_name LIKE ? OR t.description LIKE ?)")
    params.push(like, like, like, like)
  }
  if (sp.get("sla") === "breached") where.push("t.sla_resolution_breached = 1 AND t.status NOT IN ('Resolved','Closed')")

  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : ""

  const page = Math.max(1, Number(sp.get("page") || 1))
  const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize") || 25)))
  const offset = (page - 1) * pageSize

  const totalRow = await query<{ c: number }[]>(`SELECT COUNT(*) AS c FROM hr_support_tickets t${whereSql}`, params)
  const total = Number(totalRow[0]?.c || 0)

  const rows = await query<any[]>(
    `SELECT t.* FROM hr_support_tickets t${whereSql} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )

  const now = await nowZoned()
  const tickets = rows.map((t) => ({ ...t, sla_state: resolutionSlaState(t, now) }))

  // KPI aggregates over the same visibility scope (not the page filters).
  const scopeWhere: string[] = []
  const scopeParams: unknown[] = []
  if (!manage) {
    const employee = await resolveSessionEmployee(session)
    scopeWhere.push("(created_by_user_id = ? OR employee_id = ?)")
    scopeParams.push(session.userId, employee?.id ?? -1)
  }
  if (manage && !sensitive) scopeWhere.push("is_sensitive = 0")
  const scopeSql = scopeWhere.length ? ` WHERE ${scopeWhere.join(" AND ")}` : ""
  const kpiRows = await query<any[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'Open') AS open,
       SUM(status = 'In Progress') AS in_progress,
       SUM(status = 'Waiting') AS waiting,
       SUM(status = 'Resolved') AS resolved,
       SUM(status = 'Closed') AS closed,
       SUM(status NOT IN ('Resolved','Closed') AND sla_resolution_breached = 1) AS breached,
       SUM(assigned_to IS NULL AND status NOT IN ('Resolved','Closed')) AS unassigned
     FROM hr_support_tickets${scopeSql}`,
    scopeParams,
  )
  const kpi = kpiRows[0] || {}

  return NextResponse.json({
    tickets,
    kpi: {
      total: Number(kpi.total || 0),
      open: Number(kpi.open || 0),
      inProgress: Number(kpi.in_progress || 0),
      waiting: Number(kpi.waiting || 0),
      resolved: Number(kpi.resolved || 0),
      closed: Number(kpi.closed || 0),
      breached: Number(kpi.breached || 0),
      unassigned: Number(kpi.unassigned || 0),
    },
    page,
    pageSize,
    total,
    canManage: manage,
    canViewSensitive: sensitive,
  })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()

  const manage = await canManageSupport(session)
  const body = await request.json()
  const {
    support_category,
    subject,
    description,
    priority: rawPriority,
    subcategory,
    issue_type,
    attachment_path,
    attachment_name,
    employee_remarks,
    // Agent-only overrides.
    employee_id: overrideEmployeeId,
    related_attendance_id,
    related_regularisation_id,
    related_leave_id,
    related_document_id,
    related_payroll_id,
    related_offboarding_id,
  } = body || {}

  if (!support_category || !subject || !description) {
    return NextResponse.json({ error: "Category, subject and description are required" }, { status: 400 })
  }

  const category = await getCategoryBySlugOrName(String(support_category))
  const priority: Priority =
    rawPriority && PRIORITIES.includes(rawPriority) ? rawPriority : (category?.default_priority as Priority) || "Medium"

  // Resolve the employee automatically. Agents may raise on behalf of an
  // employee by id; everyone else is tied to their own linked record.
  let employee = null as Awaited<ReturnType<typeof resolveSessionEmployee>>
  if (manage && overrideEmployeeId) {
    const { getEmployeeById } = await import("@/lib/hr-attendance")
    employee = await getEmployeeById(Number(overrideEmployeeId))
  } else {
    employee = await resolveSessionEmployee(session)
  }

  const ticketId = await nextTicketId()
  const sla = await computeSla(category, priority)
  const isSensitive = category?.is_sensitive ? 1 : 0

  await query(
    `INSERT INTO hr_support_tickets
       (ticket_id, employee_id, employee_name, department, designation, manager_name,
        support_category, subcategory, issue_type, subject, description, priority,
        attachment_path, status, source, is_sensitive, employee_remarks,
        created_by_user_id, created_by_name,
        first_response_due, sla_due_date,
        related_attendance_id, related_regularisation_id, related_leave_id,
        related_document_id, related_payroll_id, related_offboarding_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ticketId,
      employee?.id ?? null,
      employee?.employee_name ?? session.name,
      employee?.department ?? null,
      employee?.designation ?? null,
      employee?.reporting_manager ?? null,
      category?.name ?? String(support_category),
      subcategory || null,
      issue_type || null,
      subject,
      description,
      priority,
      attachment_path || null,
      "Open",
      "Web",
      isSensitive,
      employee_remarks || null,
      session.userId,
      session.name,
      sla.firstResponseDue,
      sla.resolutionDue,
      related_attendance_id || null,
      related_regularisation_id || null,
      related_leave_id || null,
      related_document_id || null,
      related_payroll_id || null,
      related_offboarding_id || null,
    ],
  )

  const inserted = await query<{ id: number }[]>("SELECT id FROM hr_support_tickets WHERE ticket_id = ? LIMIT 1", [ticketId])
  const newId = Number(inserted[0]?.id)

  if (newId) {
    await logSupportEvent({ ticketId: newId, actorId: session.userId, actorName: session.name, type: "created", detail: `Ticket raised (${priority} priority)` })
    // Seed the conversation with the employee's description so the thread reads chronologically.
    if (attachment_path) {
      await query(
        "INSERT INTO hr_support_attachments (ticket_id, file_name, file_url, uploaded_by, uploaded_by_name) VALUES (?,?,?,?,?)",
        [newId, attachment_name || "attachment", attachment_path, session.userId, session.name],
      )
    }
    await addSupportMessage({
      ticketId: newId,
      authorId: session.userId,
      authorName: employee?.employee_name ?? session.name,
      authorRole: session.role,
      body: description,
      isInternal: false,
      attachmentPath: attachment_path || null,
      attachmentName: attachment_name || null,
    })
  }

  // Confirm receipt to the employee (guarded; skipped for tickets without a
  // linked employee record since there's no reliable recipient).
  if (newId && employee?.id) {
    await emitHrEmailEvent("support_ticket_created", {
      employeeId: Number(employee.id),
      sourceRecordId: ticketId,
      actorId: session.userId,
      managerName: employee?.reporting_manager ?? null,
      vars: {
        ticket_id: ticketId,
        subject,
        priority,
        status: "Open",
      },
    })
  }

  return NextResponse.json({ ticket_id: ticketId, id: newId }, { status: 201 })
}
