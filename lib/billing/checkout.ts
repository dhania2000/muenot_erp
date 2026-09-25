import { BillingError, getInvoice } from "@/lib/billing/billing-engine"
import { configureGatewaysFromEnv, getGateway, hasGateway, listGateways } from "@/lib/billing/gateways/registry"
import { nextRecordId } from "@/lib/record-ids"
import { currentTenantId, tenantInsert, tenantSelect, tenantUpdate } from "@/lib/tenant-scope"

/**
 * Invoice checkout (billing → gateway), idempotent per outstanding balance.
 * ---------------------------------------------------------------------------
 * A checkout is identified by `checkout_key = invoiceId:provider:amountMinor`,
 * unique per tenant. Retrying the same checkout (double-click, network retry,
 * reopened tab) reuses the PENDING payment row and its payment number, so the
 * provider idempotency key is stable and the ledger never records two pending
 * charges for one balance. A failed/settled attempt releases its key so a new
 * attempt for the same amount can proceed.
 */

export type CheckoutResult = {
  provider: string
  paymentNo: string
  providerId: string
  amount: number
  currency: string
  clientParams: unknown
  replayed: boolean
}

const PROVIDER_PATTERN = /^[a-z0-9_-]{2,40}$/

export function checkoutKey(invoiceId: number, provider: string, amount: number): string {
  return `${invoiceId}:${provider}:${Math.round(amount * 100)}`
}

export function normalizeProvider(raw: unknown): string {
  const provider = String(raw ?? "").toLowerCase().trim()
  if (!provider) throw new BillingError("Specify a payment provider.", 400)
  if (!PROVIDER_PATTERN.test(provider)) throw new BillingError("Invalid payment provider.", 400)
  return provider
}

function isDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ER_DUP_ENTRY")
}

type PaymentRow = { id: number; payment_no: string; status: string; reference: string | null }

export async function openInvoiceCheckout(input: {
  invoiceId: number
  provider: string
  actorId: number | null
}): Promise<CheckoutResult> {
  const { invoiceId, provider, actorId } = input

  configureGatewaysFromEnv()
  if (!hasGateway(provider)) {
    throw new BillingError(`Gateway "${provider}" is not configured. Available: ${listGateways().join(", ") || "none"}.`, 400)
  }

  const inv = await getInvoice(invoiceId)
  if (!inv) throw new BillingError("Invoice not found.", 404)
  if (inv.status === "void") throw new BillingError("Cannot charge a void invoice.", 409)

  const outstanding = Math.round((inv.total - inv.credit_applied - inv.amount_paid + Number.EPSILON) * 100) / 100
  if (outstanding <= 0) throw new BillingError("Invoice has no outstanding balance.", 409)

  const key = checkoutKey(invoiceId, provider, outstanding)
  const [existing] = (await tenantSelect("billing_payments", {
    where: "checkout_key = ?",
    params: [key],
    tail: "LIMIT 1",
  })) as PaymentRow[]

  let reused: PaymentRow | null = null
  if (existing && existing.status === "pending") {
    reused = existing
  } else if (existing) {
    await tenantUpdate("billing_payments", { checkout_key: null }, "id = ?", [existing.id])
  }

  const paymentNo = reused?.payment_no ?? (await nextRecordId("BPAY", { digits: 5, allowCustom: true }))
  const tenantId = currentTenantId()

  const result = await getGateway(provider).createPayment({
    amount: outstanding,
    currency: inv.currency,
    reference: paymentNo,
    description: `Invoice ${inv.invoice_no}`,
    metadata: { tenant_id: String(tenantId), invoice_id: String(invoiceId), invoice_no: inv.invoice_no },
    idempotencyKey: `inv-${tenantId}-${invoiceId}-${paymentNo}`,
  })

  if (reused) {
    // Providers without native idempotency mint a new order on retry; point
    // the pending row at the latest handle so the webhook settles the charge
    // the customer actually pays.
    if (reused.reference !== result.providerId) {
      await tenantUpdate("billing_payments", { reference: result.providerId }, "id = ?", [reused.id])
    }
  } else {
    try {
      await tenantInsert("billing_payments", {
        payment_no: paymentNo,
        invoice_id: invoiceId,
        amount: outstanding,
        currency: inv.currency,
        method: "gateway",
        gateway: provider,
        reference: result.providerId,
        status: "pending",
        checkout_key: key,
        note: `Awaiting ${provider} settlement`,
        created_by: actorId,
      })
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new BillingError("A checkout for this invoice is already in progress. Retry to resume it.", 409)
      }
      throw err
    }
  }

  return {
    provider,
    paymentNo,
    providerId: result.providerId,
    amount: outstanding,
    currency: inv.currency,
    clientParams: result.clientParams,
    replayed: Boolean(reused),
  }
}
