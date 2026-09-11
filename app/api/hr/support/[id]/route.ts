import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import {
  ensureSupportSchema,
  canManageSupport,
  canViewSensitive,
  resolveSessionEmployee,
  computeSla,
  getCategoryBySlugOrName,
  logSupportEvent,
  addSupportMessage,
  canTransition,
  isReopen,
  nowZoned,
  resolutionSlaState,
  notifyTicketEmail,
  getEmployeeEmail,
  getUserEmail,
  getRelatedRecords,
  PRIORITIES,
  type Priority,
} from "@/lib/hr-support"

async function loadTicket(id: string) {
  const byId = /^\d+$/.test(id)
  const rows = await query<any[]>(
    `SELECT * FROM hr_support_tickets WHERE ${byId ? "id" : "ticket_id"} = ? LIMIT 1`,
    [byId ? Number(id) : id],
  )
  return rows[0] ?? null
}

/** Can this session read the given ticket? */
async function canAccess(session: any, ticket: any, manage: boolean, sensitive: boolean) {
  if (ticket.is_sensitive && !sensitive) return false
  if (manage) return true
  const employee = await resolveSessionEmployee(session)
  return ticket.created_by_user_id === session.userId || (employee && ticket.employee_id === employee.id)
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()
  const { id } = await params

  const ticket = await loadTicket(id)
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 })

  const manage = await canManageSupport(session)
  const sensitive = await canViewSensitive(session)
  if (!(await canAccess(session, ticket, manage, sensitive))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Employees never see internal notes.
  const messages = await query<any[]>(
    `SELECT * FROM hr_support_messages WHERE ticket_id = ? ${manage ? "" : "AND is_internal = 0"} ORDER BY created_at ASC`,
    [ticket.id],
  )
  const events = await query<any[]>("SELECT * FROM hr_support_events WHERE ticket_id = ? ORDER BY created_at ASC", [ticket.id])
  const attachments = await query<any[]>("SELECT * FROM hr_support_attachments WHERE ticket_id = ? ORDER BY created_at ASC", [ticket.id])
  const related = await getRelatedRecords(ticket)

  const now = await nowZoned()
  return NextResponse.json({
    ticket: { ...ticket, sla_state: resolutionSlaState(ticket, now) },
    messages,
    events,
    attachments,
    related,
    canManage: manage,
  })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()
  const { id } = await params

  const ticket = await loadTicket(id)
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 })

  const manage = await canManageSupport(session)
  const sensitive = await canViewSensitive(session)
  if (!(await canAccess(session, ticket, manage, sensitive))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json()
  const action = String(body.action || "")
  const now = await nowZoned()

  // --- Assignment (agents only) ---
  if (action === "assign") {
    if (!manage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const assigneeId = body.assigned_to ? Number(body.assigned_to) : null
    let name: string | null = null
    if (assigneeId) {
      const u = await query<{ name: string }[]>("SELECT name FROM users WHERE id = ? LIMIT 1", [assigneeId])
      if (!u[0]) return NextResponse.json({ error: "Assignee not found" }, { status: 400 })
      name = u[0].name
    }
    await query("UPDATE hr_support_tickets SET assigned_to = ?, assigned_to_name = ?, updated_at = ? WHERE id = ?", [assigneeId, name, now, ticket.id])
    await logSupportEvent({ ticketId: ticket.id, actorId: session.userId, actorName: session.name, type: "assigned", detail: name ? `Assigned to ${name}` : "Unassigned" })
    // Notify the newly assigned agent (Section 39).
    if (assigneeId && assigneeId !== ticket.assigned_to) {
      const assigneeEmail = await getUserEmail(assigneeId)
      await notifyTicketEmail({
        to: assigneeEmail,
        subject: `[${ticket.ticket_id}] A support ticket was assigned to you`,
        html: `<p>Hi ${name || "there"},</p><p>Ticket <strong>${ticket.ticket_id}</strong> ("${ticket.subject}") from ${ticket.employee_name || "an employee"} has been assigned to you (${ticket.priority} priority).</p><p>Open the HR Support portal to work on it.</p>`,
      })
    }
    return NextResponse.json({ ok: true })
  }

  // --- Priority / category change (agents only) ---
  if (action === "reprioritise") {
    if (!manage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const priority: Priority = PRIORITIES.includes(body.priority) ? body.priority : ticket.priority
    const categoryName = body.support_category ? String(body.support_category) : ticket.support_category
    const category = await getCategoryBySlugOrName(categoryName)
    // Recompute resolution SLA from the ticket's creation time so the clock is fair.
    const created = new Date(String(ticket.created_at).replace(" ", "T") + "Z")
    const sla = await computeSla(category, priority, created)
    await query(
      "UPDATE hr_support_tickets SET priority = ?, support_category = ?, is_sensitive = ?, first_response_due = ?, sla_due_date = ?, updated_at = ? WHERE id = ?",
      [priority, category?.name ?? categoryName, category?.is_sensitive ? 1 : 0, sla.firstResponseDue, sla.resolutionDue, now, ticket.id],
    )
    await logSupportEvent({ ticketId: ticket.id, actorId: session.userId, actorName: session.name, type: "updated", detail: `Priority → ${priority}, Category → ${category?.name ?? categoryName}` })
    return NextResponse.json({ ok: true })
  }

  // --- Status change ---
  if (action === "status") {
    const to = String(body.status || "")
    if (!canTransition(ticket.status, to)) {
      return NextResponse.json({ error: `Cannot move ticket from ${ticket.status} to ${to}` }, { status: 400 })
    }
    // Employees may only reopen their own Resolved/Closed ticket.
    if (!manage && !(isReopen(ticket.status, to) && to === "Open")) {
      return NextResponse.json({ error: "Only HR agents can change ticket status" }, { status: 403 })
    }

    const sets: string[] = ["status = ?", "updated_at = ?"]
    const vals: unknown[] = [to, now]

    if (to === "Resolved") {
      sets.push("resolved_at = ?", "resolution = ?")
      vals.push(now, body.resolution || ticket.resolution || null)
      // Mark resolution breach on close-out.
      if (ticket.sla_due_date && now > ticket.sla_due_date) sets.push("sla_resolution_breached = 1")
    }
    if (to === "Closed") {
      sets.push("closed_at = ?", "closed_by = ?")
      vals.push(now, session.name)
      if (!ticket.resolved_at) { sets.push("resolved_at = ?"); vals.push(now) }
    }
    if (isReopen(ticket.status, to)) {
      sets.push("reopened_count = reopened_count + 1", "resolved_at = NULL", "closed_at = NULL", "sla_resolution_breached = 0")
    }

    vals.push(ticket.id)
    await query(`UPDATE hr_support_tickets SET ${sets.join(", ")} WHERE id = ?`, vals)
    await logSupportEvent({
      ticketId: ticket.id,
      actorId: session.userId,
      actorName: session.name,
      type: isReopen(ticket.status, to) ? "reopened" : "status_changed",
      detail: `${ticket.status} → ${to}${body.resolution ? ` · ${String(body.resolution).slice(0, 200)}` : ""}`,
    })
    if (body.resolution && to === "Resolved") {
      await addSupportMessage({ ticketId: ticket.id, authorId: session.userId, authorName: session.name, authorRole: session.role, body: `Resolution: ${body.resolution}`, isInternal: false })
    }

    // Notify the employee on resolution/closure.
    if (to === "Resolved" || to === "Closed") {
      const email = await getEmployeeEmail(ticket.employee_id)
      await notifyTicketEmail({
        to: email,
        subject: `[${ticket.ticket_id}] Your HR ticket is ${to}`,
        html: `<p>Hi ${ticket.employee_name || "there"},</p><p>Your support ticket <strong>${ticket.ticket_id}</strong> ("${ticket.subject}") has been marked <strong>${to}</strong>.</p>${body.resolution ? `<p>Resolution: ${body.resolution}</p>` : ""}<p>You can reopen it from the HR Support portal if the issue persists.</p>`,
      })
    }
    return NextResponse.json({ ok: true })
  }

  // --- First response marker (auto when an agent posts the first public reply,
  //     but also exposed for explicit use). ---
  if (action === "first_response") {
    if (!manage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (!ticket.first_response_at) {
      const breached = ticket.first_response_due && now > ticket.first_response_due ? 1 : 0
      await query("UPDATE hr_support_tickets SET first_response_at = ?, sla_response_breached = ?, updated_at = ? WHERE id = ?", [now, breached, now, ticket.id])
    }
    return NextResponse.json({ ok: true })
  }

  // --- CSAT rating (ticket owner only, after resolution) ---
  if (action === "csat") {
    const rating = Number(body.rating)
    if (!(rating >= 1 && rating <= 5)) return NextResponse.json({ error: "Rating must be 1–5" }, { status: 400 })
    if (!["Resolved", "Closed"].includes(ticket.status)) return NextResponse.json({ error: "You can rate once the ticket is resolved" }, { status: 400 })
    await query("UPDATE hr_support_tickets SET csat_rating = ?, csat_comment = ?, updated_at = ? WHERE id = ?", [rating, body.comment || null, now, ticket.id])
    await logSupportEvent({ ticketId: ticket.id, actorId: session.userId, actorName: session.name, type: "csat", detail: `Rated ${rating}/5` })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
