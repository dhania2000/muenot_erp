import "server-only"
import {
  buildInvoiceJournal,
  buildPaymentJournal,
  buildRefundJournal,
  buildCreditGrantJournal,
  buildInvoiceReversalJournal,
  buildArToCreditJournal,
  postJournal,
} from "@/lib/billing/platform-ledger"
import { createSchedule, reverseDeferredRevenue } from "@/lib/billing/revenue-recognition"
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
  refund: {
    id: number
    amount: number
    as_credit?: boolean
    /** Portion paying out a credit note's balance (clears AR, not Refunds). */
    credit_note_settled?: number
    created_at?: string | null
  },
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
      lines: buildRefundJournal(amount, {
        asCredit: Boolean(refund.as_credit),
        arSettled: refund.credit_note_settled ?? 0,
      }),
    },
    session,
  )
}

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Void of an issued invoice. First makes sure the original invoice posting
 * exists (idempotent — covers a best-effort post that failed at issue time) so
 * the reversal always has something to reverse, then reverses it in full:
 * unrecognized months are cancelled out of Deferred Revenue, recognized months
 * out of Revenue, GST output is reduced and applied account credit restored.
 */
export async function postVoidAccounting(inv: InvoiceLike, session?: SessionPayload | null): Promise<void> {
  if (String(inv.status ?? "") === "draft") return
  const gross = round2(inv.total)
  if (!(gross > 0)) return
  await postInvoiceAccounting({ ...inv, status: "open" }, session)
  const tax = round2(inv.tax_total ?? 0)
  const { fromDeferred } = await reverseDeferredRevenue({
    invoiceId: inv.id,
    sourceType: "void",
    sourceId: inv.id,
    amount: round2(gross - tax),
  })
  await postJournal(
    {
      sourceType: "invoice",
      sourceId: inv.id,
      eventType: "invoice_voided",
      entryDate: today(),
      memo: `Void ${inv.invoice_no ?? inv.id}`,
      lines: buildInvoiceReversalJournal({
        gross,
        tax,
        fromDeferred,
        creditApplied: round2(inv.credit_applied ?? 0),
      }),
    },
    session,
  )
}

/**
 * A GST credit note (negative invoice) against a source invoice. Reverses the
 * credited net revenue — from the source's unrecognized deferred months first,
 * then from recognized revenue — plus its GST, against AR. The resulting AR
 * credit is later settled by a refund or converted to account credit.
 */
export async function postCreditNoteAccounting(
  creditNote: InvoiceLike,
  source: { id: number },
  session?: SessionPayload | null,
): Promise<void> {
  const gross = round2(Math.abs(creditNote.total))
  if (gross === 0) return
  const tax = round2(Math.abs(creditNote.tax_total ?? 0))
  const { fromDeferred } = await reverseDeferredRevenue({
    invoiceId: source.id,
    sourceType: "credit_note",
    sourceId: creditNote.id,
    amount: round2(gross - tax),
  })
  await postJournal(
    {
      sourceType: "invoice",
      sourceId: creditNote.id,
      eventType: "credit_note_issued",
      entryDate: String(creditNote.issue_date ?? today()).slice(0, 10),
      memo: `Credit note ${creditNote.invoice_no ?? creditNote.id}`,
      lines: buildInvoiceReversalJournal({ gross, tax, fromDeferred }),
    },
    session,
  )
}

/** Credit-note balance issued as spendable account credit: Dr AR / Cr Customer Credit. */
export async function postCreditFromCreditNoteAccounting(
  credit: { id: number; amount: number; created_at?: string | null },
  session?: SessionPayload | null,
): Promise<void> {
  const amount = round2(credit.amount)
  if (amount <= 0) return
  await postJournal(
    {
      sourceType: "credit",
      sourceId: credit.id,
      eventType: "credit_from_credit_note",
      entryDate: String(credit.created_at ?? today()).slice(0, 10),
      memo: `Credit note balance to account credit #${credit.id}`,
      lines: buildArToCreditJournal(amount),
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
