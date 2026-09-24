import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { createItem, deleteItem, getVendorDirectoryRow, listVendorItems } from "@/lib/vendor-portal/store"
import { isVendorPortalItemResource } from "@/lib/vendor-portal/config"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/** List every shared record published to a vendor (all resources). */
export async function GET(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const vendorId = Number(new URL(request.url).searchParams.get("vendorId"))
  if (!vendorId) return NextResponse.json({ error: "vendorId is required" }, { status: 400 })

  const items = await listVendorItems(tenantId, vendorId)
  return NextResponse.json({ items })
}

/** Unpublish a shared record from a vendor. */
export async function DELETE(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const url = new URL(request.url)
  const body = await request.json().catch(() => null)
  const vendorId = Number(body?.vendorId ?? url.searchParams.get("vendorId"))
  const itemId = Number(body?.itemId ?? url.searchParams.get("itemId"))
  if (!vendorId || !itemId) {
    return NextResponse.json({ error: "vendorId and itemId are required" }, { status: 400 })
  }

  const removed = await deleteItem(tenantId, vendorId, itemId)
  if (!removed) return NextResponse.json({ error: "Shared record not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

/** Publish a shared record (PO/invoice/payment/document/compliance) to a vendor. */
export async function POST(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const body = await request.json().catch(() => null)
  const vendorId = Number(body?.vendorId)
  const resource = body?.resource
  const title = String(body?.title ?? "").trim()
  if (!vendorId || !isVendorPortalItemResource(resource) || !title) {
    return NextResponse.json({ error: "vendorId, a valid resource, and title are required" }, { status: 400 })
  }

  if (!(await getVendorDirectoryRow(vendorId))) {
    return NextResponse.json({ error: "Vendor not found" }, { status: 404 })
  }

  const id = await createItem({
    tenantId,
    vendorId,
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
