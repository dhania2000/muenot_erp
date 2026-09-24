import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import {
  countPortalPlacedOrdersByStatus,
  isPortalOrderStatus,
  listPortalPlacedOrders,
  setPortalOrderStatus,
} from "@/lib/portal/store"

/**
 * SPEC 117 — Sales Order Management (staff side).
 *
 * Lists and updates the orders that CLIENTS placed through the client portal.
 * Scoped to the acting tenant (staff may see all of the tenant's clients). The
 * tenant id is derived from the verified session — never from request input.
 */
export async function GET(request: Request) {
  const session = await requireFeature("sales.view_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const url = new URL(request.url)
  const status = url.searchParams.get("status") || undefined
  const clientId = url.searchParams.get("clientId") ? Number(url.searchParams.get("clientId")) : undefined

  const [orders, counts] = await Promise.all([
    listPortalPlacedOrders(tenantId, { status, clientId }),
    countPortalPlacedOrdersByStatus(tenantId),
  ])
  return NextResponse.json({ orders, counts })
}

export async function PATCH(request: Request) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const body = await request.json().catch(() => null)
  const orderId = Number(body?.orderId)
  const status = body?.status
  if (!orderId || !isPortalOrderStatus(status)) {
    return NextResponse.json({ error: "orderId and a valid status are required" }, { status: 400 })
  }

  const updated = await setPortalOrderStatus(tenantId, orderId, status)
  if (!updated) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
