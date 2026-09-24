import { NextResponse } from "next/server"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { vendorCanAccess } from "@/lib/vendor-portal/access"
import { createMessage, listMessages } from "@/lib/vendor-portal/store"

export const runtime = "nodejs"

/**
 * SPEC 119 — Vendor Portal · communication thread (Phase 2).
 * Direct messages between the vendor and the accounts-payable team. Every
 * read/write is scoped to the verified (tenant, vendor); messages sent here are
 * always stamped author_type='vendor'.
 */
export async function GET() {
  const session = await getVendorPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await vendorCanAccess(session.tenantId, session.vendorId, "messages"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }
  const messages = await listMessages(session.tenantId, session.vendorId)
  return NextResponse.json({ messages })
}

export async function POST(request: Request) {
  const session = await getVendorPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await vendorCanAccess(session.tenantId, session.vendorId, "messages"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }
  const body = await request.json().catch(() => null)
  const message = String(body?.body ?? "").trim()
  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 })

  const created = await createMessage({
    tenantId: session.tenantId,
    vendorId: session.vendorId,
    authorType: "vendor",
    portalUserId: session.portalUserId,
    authorName: session.name,
    body: message.slice(0, 5000),
  })
  return NextResponse.json({ message: created }, { status: 201 })
}
