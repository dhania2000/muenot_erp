import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { query } from "@/lib/db"
import { createItem } from "@/lib/portal/store"
import { isPortalItemResource } from "@/lib/portal/config"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/** Publish a shared record (quote/order/invoice/payment/document/project) to a client. */
export async function POST(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const body = await request.json().catch(() => null)
  const clientId = Number(body?.clientId)
  const resource = body?.resource
  const title = String(body?.title ?? "").trim()
  if (!clientId || !isPortalItemResource(resource) || !title) {
    return NextResponse.json({ error: "clientId, a valid resource, and title are required" }, { status: 400 })
  }

  const client = await query<{ id: number }[]>(`SELECT id FROM clients WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    clientId,
    tenantId,
  ])
  if (!client[0]) return NextResponse.json({ error: "Client not found" }, { status: 404 })

  const id = await createItem({
    tenantId,
    clientId,
    resource,
    reference: body?.reference ?? null,
    title: title.slice(0, 200),
    description: body?.description ?? null,
    status: body?.status ?? null,
    amount: body?.amount != null ? Number(body.amount) : null,
    currency: body?.currency ?? null,
    issueDate: body?.issueDate ?? null,
    dueDate: body?.dueDate ?? null,
    fileUrl: body?.fileUrl ?? null,
    fileName: body?.fileName ?? null,
    createdBy: session.userId,
  })
  return NextResponse.json({ id }, { status: 201 })
}
