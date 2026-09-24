import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { createMessage, listMessages } from "@/lib/portal/store"

export async function GET() {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await clientCanAccess(session.tenantId, session.clientId, "messages"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }
  const messages = await listMessages(session.tenantId, session.clientId)
  return NextResponse.json({ messages })
}

export async function POST(request: Request) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await clientCanAccess(session.tenantId, session.clientId, "messages"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }
  const body = await request.json().catch(() => null)
  const message = String(body?.body ?? "").trim()
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 })

  const created = await createMessage({
    tenantId: session.tenantId,
    clientId: session.clientId,
    portalUserId: session.portalUserId,
    authorName: session.name,
    body: message.slice(0, 5000),
  })
  return NextResponse.json({ message: created }, { status: 201 })
}
