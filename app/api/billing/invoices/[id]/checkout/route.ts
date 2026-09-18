import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantId, runForTenant, tenantInsert } from "@/lib/tenant-scope"
import { getInvoice } from "@/lib/billing/billing-engine"
import { configureGatewaysFromEnv, getGateway, hasGateway, listGateways } from "@/lib/billing/gateways/registry"
import { nextRecordId } from "@/lib/record-ids"

/**
 * SPEC 21 — Open a gateway charge for an invoice (Phase 3, billing → gateway).
 * ---------------------------------------------------------------------------
 * Session-protected (admin billing). Opens a charge through the requested
 * provider and records a PENDING payment stamped with the provider handle so
 * the later webhook settles the SAME row. The tenant id is embedded in the
 * charge metadata so the (session-less) webhook can route the event back.
 *
 * The response returns only `clientParams` — the provider-specific bag the
 * browser hands to that provider's checkout widget. Business logic never reads
 * it, keeping this route provider-agnostic.
 */

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await ctx.params
  const invoiceId = Number(id)
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return NextResponse.json({ error: "Invalid invoice id." }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as { provider?: string }
  const provider = String(body.provider ?? "").toLowerCase().trim()

  configureGatewaysFromEnv()
  if (!provider) return NextResponse.json({ error: "Specify a payment provider.", available: listGateways() }, { status: 400 })
  if (!hasGateway(provider)) {
    return NextResponse.json({ error: `Gateway "${provider}" is not configured.`, available: listGateways() }, { status: 400 })
  }

  const tenantId = session.tenantId
  return runForTenant({ tenantId: tenantId as number }, async () => {
    const inv = await getInvoice(invoiceId)
    if (!inv) return NextResponse.json({ error: "Invoice not found." }, { status: 404 })
    if (inv.status === "void") return NextResponse.json({ error: "Cannot charge a void invoice." }, { status: 409 })

    const outstanding = Math.round((inv.total - inv.credit_applied - inv.amount_paid + Number.EPSILON) * 100) / 100
    if (outstanding <= 0) return NextResponse.json({ error: "Invoice has no outstanding balance." }, { status: 409 })

    const gateway = getGateway(provider)
    const paymentNo = await nextRecordId("BPAY", { digits: 5, allowCustom: true })

    // Idempotency key ties a retried checkout to the same provider charge.
    const idempotencyKey = `inv-${currentTenantId()}-${invoiceId}-${paymentNo}`

    const result = await gateway.createPayment({
      amount: outstanding,
      currency: inv.currency,
      reference: paymentNo,
      description: `Invoice ${inv.invoice_no}`,
      metadata: { tenant_id: String(currentTenantId()), invoice_id: String(invoiceId), invoice_no: inv.invoice_no },
      idempotencyKey,
    })

    // Record the pending payment keyed by the provider handle so the webhook
    // can find and settle it. `reference` = the provider id we correlate on.
    await tenantInsert("billing_payments", {
      payment_no: paymentNo,
      invoice_id: invoiceId,
      amount: outstanding,
      currency: inv.currency,
      method: "gateway",
      gateway: provider,
      reference: result.providerId,
      status: "pending",
      note: `Awaiting ${provider} settlement`,
    })

    return NextResponse.json({
      provider,
      paymentNo,
      providerId: result.providerId,
      amount: outstanding,
      currency: inv.currency,
      clientParams: result.clientParams,
    })
  })
}
