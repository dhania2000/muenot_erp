import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { listPortalCatalog } from "@/lib/portal/store"

export const runtime = "nodejs"

/**
 * SPEC 117 — product catalog a CLIENT browses to build an order from the
 * portal. tenant is derived from the verified portal session; the client must
 * have the `orders` resource granted (fail-closed) to see the catalog.
 */
export async function GET(request: Request) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const allowed = await clientCanAccess(session.tenantId, session.clientId, "orders")
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const search = url.searchParams.get("search") || undefined

  const products = await listPortalCatalog(search)
  return NextResponse.json({ products })
}
