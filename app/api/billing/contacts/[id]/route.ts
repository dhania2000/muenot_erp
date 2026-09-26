import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { updateBillingContact, deleteBillingContact, BillingError } from "@/lib/billing/billing-engine"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof BillingError) {
    return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
  }
  // requireOwnedRow refuses cross-tenant ids; never disclose that the row exists.
  if ((err as any)?.status === 404 || /not found/i.test(String((err as any)?.message ?? ""))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  console.error(fallback, err)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

export async function PATCH(request: Request, { params }: Ctx) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  try {
    const contact = await updateBillingContact(id, body, session)
    await recordAuditLogFromRequest(request, {
      action: "billing.contact.update",
      entityType: "billing_contact",
      entityId: id,
      entityLabel: contact.email,
      after: body as Record<string, unknown>,
    }).catch(() => {})
    return NextResponse.json({ ok: true, contact })
  } catch (err) {
    return errorResponse(err, "Failed to update billing contact")
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    await deleteBillingContact(id)
    await recordAuditLogFromRequest(request, {
      action: "billing.contact.delete",
      entityType: "billing_contact",
      entityId: id,
    }).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, "Failed to delete billing contact")
  }
}
