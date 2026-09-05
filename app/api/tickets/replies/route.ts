import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

// Returns the ticket row if the session user is allowed to see it, otherwise null.
async function accessibleTicket(userId: number, role: "admin" | "employee", ticketId: number) {
  const rows = await query<any[]>("SELECT * FROM hr_tickets WHERE id = ? LIMIT 1", [ticketId])
  const ticket = rows[0]
  if (!ticket) return { ticket: null, canManage: false }
  const canManage = role === "admin" || (await userHasFeature(userId, role, "tickets.manage"))
  if (canManage) return { ticket, canManage }
  // Non-managers may only touch their own tickets.
  return { ticket: ticket.created_by === userId ? ticket : null, canManage }
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const ticketId = Number(request.nextUrl.searchParams.get("ticketId"))
  if (!ticketId) return NextResponse.json({ error: "ticketId required" }, { status: 400 })

  const { ticket } = await accessibleTicket(session.userId, session.role, ticketId)
  if (!ticket) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const replies = await query<any[]>(
    "SELECT * FROM hr_ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC",
    [ticketId],
  )
  return NextResponse.json({ replies })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json()
  const ticketId = Number(body.ticket_id)
  const message = String(body.message || "").trim()
  if (!ticketId || !message) return NextResponse.json({ error: "Ticket and message are required" }, { status: 400 })

  const { ticket, canManage } = await accessibleTicket(session.userId, session.role, ticketId)
  if (!ticket) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await query(
    "INSERT INTO hr_ticket_replies (ticket_id, message, author_id, author_name, is_staff) VALUES (?,?,?,?,?)",
    [ticketId, message, session.userId, session.name, canManage ? 1 : 0],
  )
  // Touch the ticket so it sorts as recently active.
  await query("UPDATE hr_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [ticketId])
  return NextResponse.json({ ok: true }, { status: 201 })
}
