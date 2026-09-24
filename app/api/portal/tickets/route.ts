import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { createTicket, listTickets } from "@/lib/portal/store"

export async function GET() {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await clientCanAccess(session.tenantId, session.clientId, "tickets"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }
  const tickets = await listTickets(session.tenantId, session.clientId)
  return NextResponse.json({ tickets })
}

const PRIORITIES = ["low", "normal", "high", "urgent"] as const

export async function POST(request: Request) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await clientCanAccess(session.tenantId, session.clientId, "tickets"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const subject = String(body?.subject ?? "").trim()
  const message = String(body?.body ?? "").trim()
  const priority = PRIORITIES.includes(body?.priority) ? body.priority : "normal"
  if (!subject || !message) {
    return NextResponse.json({ error: "Subject and message are required" }, { status: 400 })
  }

  const ticket = await createTicket({
    tenantId: session.tenantId,
    clientId: session.clientId,
    portalUserId: session.portalUserId,
    authorName: session.name,
    subject: subject.slice(0, 200),
    priority,
    body: message,
  })
  return NextResponse.json({ ticket }, { status: 201 })
}
