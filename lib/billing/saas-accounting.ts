import "server-only"
import { buildInvoiceJournal, buildPaymentJournal, buildRefundJournal, buildCreditGrantJournal, postJournal } from "@/lib/billing/platform-ledger"
import { createSchedule } from "@/lib/billing/revenue-recognition"
import { monthsBetween } from "@/lib/billing/revenue-schedule"
import { round2 } from "@/lib/billing/billing-math"
import type { SessionPayload } from "@/lib/auth"

/**
 * SaaS accounting orchestration.
 * ---------------------------------------------------------------------------
 * Bridges the billing engine's money events to the platform seller ledger and
 * deferred-revenue schedules. Every function here is idempotent and best-effort
 * from the caller's side: the billing engine wraps these in try/catch so a
 * ledger hiccup can never block issuing an invoice or recording a payment, yet
 * a later retry still posts exactly once.
 *
 * A prepaid subscription invoice spanning more than one service month defers its
 * net-of-tax revenue and builds a straight-line recognition schedule; monthly
 * and one-off invoices recognize immediately.
 */

type InvoiceLike = {
  id: number
  invoice_no?: string
  invoice_type?: string | null
  status?: string | null
  total: number
  tax_total?: number | null
  credit_applied?: number | null
  subscription_id?: number | null
  currency?: string | null
  period_start?: string | null
  period_end?: string | null
  issue_date?: string | null
}

const DEFERRABLE_TYPES = new Set(["recurring", "one_time"])

/** True when the invoice is a prepaid multi-month subscription charge. */
function isDeferred(inv: InvoiceLike): boolean {
  if (!(inv.total > 0)) return false
  if (!DEFERRABLE_TYPES.has(String(inv.invoice_type ?? "recurring"))) return false
  if (!inv.period_start || !inv.period_end) return false
  return monthsBetween(inv.period_start, inv.period_end) > 1
}

/**
 * Post an invoice to the platform ledger and, when it is a prepaid multi-month
 * charge, defer its net-of-tax revenue with a recognition schedule. No-op for
 * draft invoices. Idempotent.
 */
export async function postInvoiceAccounting(inv: InvoiceLike, session?: SessionPayload | null): Promise<void> {
  if (String(inv.status ?? "") === "draft") return
  const deferred = isDeferred(inv)
  const entryDate = String(inv.issue_date ?? inv.period_start ?? new Date().toISOString()).slice(0, 10)
  await postJournal(
    {
      sourceType: "invoice",
      sourceId: inv.id,
      eventType: deferred ? "invoice_deferred" : "invoice_finalized",
      entryDate,
      memo: `Invoice ${inv.invoice_no ?? inv.id}`,
      lines: buildInvoiceJournal(inv, { deferred }),
    },
    session,
  )
  if (deferred) {
    const revenuePortion = round2(inv.total - round2(inv.tax_total ?? 0))
    await createSchedule({
      invoiceId: inv.id,
      subscriptionId: inv.subscription_id ?? null,
      amount: revenuePortion,
      months: monthsBetween(inv.period_start!, inv.period_end!),
      startDate: String(inv.period_start).slice(0, 10),
      currency: inv.currency ?? "INR",
    })
  }
}

export async function postPaymentAccounting(
  payment: { id: number; amount: number; paid_at?: string | null; invoice_no?: string | null },
  session?: SessionPayload | null,
): Promise<void> {
  const amount = round2(payment.amount)
  if (amount === 0) return
  await postJournal(
    {
      sourceType: "payment",
      sourceId: payment.id,
      eventType: "payment_received",
      entryDate: String(payment.paid_at ?? new Date().toISOString()).slice(0, 10),
      memo: `Payment for ${payment.invoice_no ?? ""}`.trim(),
      lines: buildPaymentJournal(amount),
    },
    session,
  )
}

export async function postRefundAccounting(
  refund: { id: number; amount: number; as_credit?: boolean; created_at?: string | null },
  session?: SessionPayload | null,
): Promise<void> {
  const amount = round2(refund.amount)
  if (amount === 0) return
  await postJournal(
    {
      sourceType: "refund",
      sourceId: refund.id,
      eventType: "refund_issued",
      entryDate: String(refund.created_at ?? new Date().toISOString()).slice(0, 10),
      memo: `Refund #${refund.id}`,
      lines: buildRefundJournal(amount, { asCredit: Boolean(refund.as_credit) }),
    },
    session,
  )
}

export async function postCreditGrantAccounting(
  credit: { id: number; amount: number; created_at?: string | null },
  session?: SessionPayload | null,
): Promise<void> {
  const amount = round2(credit.amount)
  if (amount <= 0) return
  await postJournal(
    {
      sourceType: "credit",
      sourceId: credit.id,
      eventType: "credit_granted",
      entryDate: String(credit.created_at ?? new Date().toISOString()).slice(0, 10),
      memo: `Account credit #${credit.id}`,
      lines: buildCreditGrantJournal(amount),
    },
    session,
  )
}
