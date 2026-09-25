import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runForTenant } from "@/lib/tenant-scope"
import { BillingError } from "@/lib/billing/billing-engine"
import { normalizeProvider, openInvoiceCheckout } from "@/lib/billing/checkout"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const runtime = "nodejs"

/**
 * Open a gateway charge for an invoice (Phase 3, billing → gateway).
 * ---------------------------------------------------------------------------
 * Session-protected (tenant admin). The tenant comes only from the verified
 * session, never from the body. Retries of the same checkout are idempotent
 * (see lib/billing/checkout.ts). Every attempt — success, replay, rejection —
 * is written to the audit log.
 *
 * The response returns only `clientParams` — the provider-specific bag the
 * browser hands to that provider's checkout widget.
 */

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const tenantId = Number(session.tenantId)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "No tenant bound to this session." }, { status: 403 })
  }

  const { id } = await ctx.params
  const invoiceId = Number(id)
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return NextResponse.json({ error: "Invalid invoice id." }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as { provider?: unknown }

  return runForTenant({ tenantId }, async () => {
    let provider = ""
    try {
      provider = normalizeProvider(body.provider)
      const result = await openInvoiceCheckout({ invoiceId, provider, actorId: session.userId ?? null })
      await recordAuditLogFromRequest(req, {
        action: "billing.checkout_open",
        entityType: "billing_invoice",
        entityId: invoiceId,
        metadata: { provider, paymentNo: result.paymentNo, amount: result.amount, currency: result.currency, replayed: result.replayed },
      })
      return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
    } catch (err) {
      const status = err instanceof BillingError ? err.status : 502
      const message = err instanceof BillingError ? err.message : "Payment gateway rejected the checkout."
      if (!(err instanceof BillingError)) console.error("[billing] checkout failed:", err)
      await recordAuditLogFromRequest(req, {
        action: "billing.checkout_open",
        result: status === 403 || status === 404 ? "denied" : "failure",
        entityType: "billing_invoice",
        entityId: invoiceId,
        metadata: { provider: provider || null, status, error: message },
      })
      return NextResponse.json({ error: message }, { status })
    }
  })
}
