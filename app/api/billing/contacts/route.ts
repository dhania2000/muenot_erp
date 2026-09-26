import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listBillingContacts, createBillingContact, BillingError } from "@/lib/billing/billing-engine"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const runtime = "nodejs"

/**
 * Spec46 (#84-85) — billing contacts for the customer portal. Tenant-scoped by
 * the billing engine (tenantSelect/tenantInsert); admin-only via billingGuard.
 * Create is naturally idempotent: a repeated email returns 409, not a duplicate.
 */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    return NextResponse.json({ contacts: await listBillingContacts() })
  } catch (err) {
    console.error("GET /api/billing/contacts failed:", err)
    return NextResponse.json({ error: "Failed to load billing contacts" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  try {
    const contact = await createBillingContact(body, session)
    await recordAuditLogFromRequest(request, {
      action: "billing.contact.create",
      entityType: "billing_contact",
      entityId: contact.id,
      entityLabel: contact.email,
      after: { name: contact.name, email: contact.email, role: contact.role, is_primary: contact.is_primary },
    }).catch(() => {})
    return NextResponse.json({ ok: true, contact }, { status: 201 })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("POST /api/billing/contacts failed:", err)
    return NextResponse.json({ error: "Failed to create billing contact" }, { status: 500 })
  }
}
