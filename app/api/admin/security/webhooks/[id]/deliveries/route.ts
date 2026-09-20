import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listDeliveries } from "@/lib/webhooks-store"
import { retryDelivery } from "@/lib/webhooks/dispatcher"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const deliveries = await listDeliveries(ctx.tenantId, Number(id))
  return NextResponse.json({ deliveries })
}

/** Manually re-sends one delivery by id (passed in the body), regardless of its backoff window. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { deliveryId?: number } | null
  if (!body?.deliveryId) return NextResponse.json({ error: "deliveryId is required" }, { status: 400 })

  const deliveries = await listDeliveries(ctx.tenantId, Number(id), 100)
  const delivery = deliveries.find((d) => d.id === body.deliveryId)
  if (!delivery) return NextResponse.json({ error: "Delivery not found" }, { status: 404 })

  await retryDelivery(delivery)
  const refreshed = await listDeliveries(ctx.tenantId, Number(id), 100)
  return NextResponse.json({ delivery: refreshed.find((d) => d.id === body.deliveryId) })
}
