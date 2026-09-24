import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { createClientOrder } from "@/lib/portal/store"

/**
 * SPEC 117 / 118 — a CLIENT places an order from the portal.
 *
 * tenant_id and client_id are taken exclusively from the verified portal
 * session, never from request input. The client must have the `orders`
 * resource granted (fail-closed) before an order can be created.
 */
export async function POST(request: Request) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const allowed = await clientCanAccess(session.tenantId, session.clientId, "orders")
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const title = String(body?.title ?? "").trim()
  const description = body?.description != null ? String(body.description).trim() : null
  const currency = body?.currency != null ? String(body.currency).trim().toUpperCase().slice(0, 10) : null

  let amount: number | null = null
  if (body?.amount != null && body.amount !== "") {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "Enter a valid amount" }, { status: 400 })
    }
    amount = Math.round(n * 100) / 100
  }

  if (!title) return NextResponse.json({ error: "A short order summary is required" }, { status: 400 })
  if (title.length > 200) return NextResponse.json({ error: "Summary is too long" }, { status: 400 })

  const id = await createClientOrder({
    tenantId: session.tenantId,
    clientId: session.clientId,
    portalUserId: session.portalUserId,
    authorName: session.name,
    title,
    description,
    amount,
    currency,
  })

  return NextResponse.json({ ok: true, id }, { status: 201 })
}
