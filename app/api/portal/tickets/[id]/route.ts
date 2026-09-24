import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { addTicketMessage, getTicket } from "@/lib/portal/store"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await clientCanAccess(session.tenantId, session.clientId, "tickets"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }
  const { id } = await params
  const ticketId = Number(id)
  if (!Number.isInteger(ticketId)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const result = await getTicket(session.tenantId, session.clientId, ticketId)
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(result)
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await clientCanAccess(session.tenantId, session.clientId, "tickets"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }
  const { id } = await params
  const ticketId = Number(id)
  if (!Number.isInteger(ticketId)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => null)
  const message = String(body?.body ?? "").trim()
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 })

  const created = await addTicketMessage({
    tenantId: session.tenantId,
    clientId: session.clientId,
    ticketId,
    authorName: session.name,
    body: message,
  })
  if (!created) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ message: created }, { status: 201 })
}
