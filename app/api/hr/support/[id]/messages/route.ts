import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import {
  ensureSupportSchema,
  canManageSupport,
  canViewSensitive,
  resolveSessionEmployee,
  addSupportMessage,
  logSupportEvent,
  nowZoned,
  notifyTicketEmail,
  getEmployeeEmail,
  getUserEmail,
} from "@/lib/hr-support"

// POST /api/hr/support/[id]/messages — add a reply or (agents) an internal note.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()
  const { id } = await params

  const rows = await query<any[]>("SELECT * FROM hr_support_tickets WHERE id = ? OR ticket_id = ? LIMIT 1", [Number(id) || -1, id])
  const ticket = rows[0]
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 })

  const manage = await canManageSupport(session)
  const sensitive = await canViewSensitive(session)
  if (ticket.is_sensitive && !sensitive && !manage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!manage) {
    const employee = await resolveSessionEmployee(session)
    const owns = ticket.created_by_user_id === session.userId || (employee && ticket.employee_id === employee.id)
    if (!owns) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json()
  const text = String(body.body || "").trim()
  const isInternal = Boolean(body.is_internal) && manage // only agents can post internal notes
  if (!text) return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 })

  const now = await nowZoned()

  await addSupportMessage({
    ticketId: ticket.id,
    authorId: session.userId,
    authorName: session.name,
    authorRole: session.role,
    body: text,
    isInternal,
    attachmentPath: body.attachment_path || null,
    attachmentName: body.attachment_name || null,
  })

  if (body.attachment_path) {
    await query(
      "INSERT INTO hr_support_attachments (ticket_id, file_name, file_url, uploaded_by, uploaded_by_name) VALUES (?,?,?,?,?)",
      [ticket.id, body.attachment_name || "attachment", body.attachment_path, session.userId, session.name],
    )
  }

  // First public agent reply marks first response + SLA compliance.
  if (manage && !isInternal && !ticket.first_response_at) {
    const breached = ticket.first_response_due && now > ticket.first_response_due ? 1 : 0
    await query("UPDATE hr_support_tickets SET first_response_at = ?, sla_response_breached = ?, updated_at = ? WHERE id = ?", [now, breached, now, ticket.id])
    await logSupportEvent({ ticketId: ticket.id, actorId: session.userId, actorName: session.name, type: "first_response", detail: breached ? "First response (SLA breached)" : "First response within SLA" })
  } else {
    await query("UPDATE hr_support_tickets SET updated_at = ? WHERE id = ?", [now, ticket.id])
  }

  await logSupportEvent({
    ticketId: ticket.id,
    actorId: session.userId,
    actorName: session.name,
    type: isInternal ? "internal_note" : "message",
    detail: isInternal ? "Internal note added" : `${session.name} replied`,
  })

  // Notify the counterparty on public replies (Section 39).
  if (!isInternal) {
    if (manage) {
      // Agent replied → notify the employee.
      const email = await getEmployeeEmail(ticket.employee_id)
      await notifyTicketEmail({
        to: email,
        subject: `[${ticket.ticket_id}] New reply from HR`,
        html: `<p>Hi ${ticket.employee_name || "there"},</p><p>HR replied to your ticket <strong>${ticket.ticket_id}</strong>:</p><blockquote>${text}</blockquote><p>Open the HR Support portal to respond.</p>`,
      })
    } else if (ticket.assigned_to) {
      // Employee replied → notify the assigned agent.
      const email = await getUserEmail(ticket.assigned_to)
      await notifyTicketEmail({
        to: email,
        subject: `[${ticket.ticket_id}] New reply from ${ticket.employee_name || "the employee"}`,
        html: `<p>Hi ${ticket.assigned_to_name || "there"},</p><p>${ticket.employee_name || "The employee"} replied to ticket <strong>${ticket.ticket_id}</strong>:</p><blockquote>${text}</blockquote><p>Open the HR Support portal to respond.</p>`,
      })
    }
  }

  return NextResponse.json({ ok: true }, { status: 201 })
}
