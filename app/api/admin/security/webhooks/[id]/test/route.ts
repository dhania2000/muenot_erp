import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { createDelivery, getEndpointById, listDeliveries } from "@/lib/webhooks-store"
import { retryDelivery } from "@/lib/webhooks/dispatcher"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** Sends a synthetic `webhook.test` ping to this endpoint right now, so the admin can verify signature handling. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const endpoint = await getEndpointById(ctx.tenantId, Number(id))
  if (!endpoint) return NextResponse.json({ error: "Endpoint not found" }, { status: 404 })

  const payload = JSON.stringify({
    event: "webhook.test",
    data: { message: "This is a test delivery from Security & Access." },
    emittedAt: new Date().toISOString(),
  })
  const deliveryId = await createDelivery({
    endpointId: endpoint.id,
    tenantId: ctx.tenantId,
    eventType: "webhook.test",
    payload,
  })
  const rows = await listDeliveries(ctx.tenantId, endpoint.id, 1)
  const delivery = rows.find((d) => d.id === deliveryId)
  if (delivery) await retryDelivery(delivery)
  const [result] = await listDeliveries(ctx.tenantId, endpoint.id, 1)
  return NextResponse.json({ delivery: result })
}
