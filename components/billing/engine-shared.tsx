"use client"

/**
 * SPEC 20 — Shared client types and presentation helpers for the billing
 * engine UI (invoices, coupons, credits, refunds, reconciliation, run). Mirrors
 * the server types in lib/billing/billing-engine.ts. Money formatting is reused
 * from the subscription UI helpers so both surfaces render consistently.
 */

export { formatMoney } from "./billing-shared"

export type InvoiceStatus = "draft" | "open" | "partially_paid" | "paid" | "void" | "refunded"

export type InvoiceLine = {
  id: number
  invoice_id: number
  line_type: "subscription" | "one_time" | "proration" | "adjustment"
  description: string
  quantity: number
  unit_amount: number
  amount: number
  taxable: boolean
}

export type Invoice = {
  id: number
  invoice_no: string
  subscription_id: number | null
  customer_name: string
  bill_to_email: string | null
  bill_to_company: string | null
  bill_to_tax_id: string | null
  bill_to_address: string | null
  bill_to_city: string | null
  bill_to_state: string | null
  bill_to_postal: string | null
  bill_to_country: string | null
  credit_note_of: number | null
  invoice_type: "recurring" | "one_time" | "credit_note"
  currency: string
  subtotal: number
  discount_total: number
  coupon_code: string | null
  tax_rate: number
  tax_total: number
  credit_applied: number
  adjustment_total: number
  total: number
  amount_paid: number
  amount_refunded: number
  balance: number
  status: InvoiceStatus
  issue_date: string
  due_date: string | null
  period_start: string | null
  period_end: string | null
  memo: string | null
  last_sent_at: string | null
  last_sent_to: string | null
  created_at: string
}

export type InvoiceView = Invoice & { lines: InvoiceLine[] }

export type CouponRow = {
  id: number
  coupon_code: string
  name: string
  discount_type: "percent" | "fixed"
  value: number
  currency: string
  duration: "once" | "forever" | "repeating"
  duration_months: number | null
  min_amount: number | null
  max_redemptions: number | null
  times_redeemed: number
  valid_from: string | null
  valid_until: string | null
  is_active: boolean
  created_at: string
}

export type CreditEntry = {
  id: number
  credit_no: string
  entry_type: "credit" | "debit" | "adjustment"
  reason: string
  amount: number
  currency: string
  invoice_id: number | null
  status: "available" | "applied" | "void"
  created_at: string
}

export type Payment = {
  id: number
  payment_no: string
  invoice_id: number
  amount: number
  currency: string
  method: string
  gateway: string | null
  reference: string | null
  status: "succeeded" | "pending" | "failed"
  reconciled: boolean
  paid_at: string | null
  note: string | null
  created_at: string
}

export type Refund = {
  id: number
  refund_no: string
  invoice_id: number
  payment_id: number | null
  amount: number
  currency: string
  reason: string | null
  status: "pending" | "succeeded" | "failed"
  refunded_at: string | null
  created_at: string
  invoice_no?: string | null
  customer_name?: string | null
}

export type ReconEntry = {
  id: number
  statement_ref: string
  gateway: string
  payout_ref: string | null
  amount: number
  currency: string
  payment_id: number | null
  invoice_no: string | null
  status: "matched" | "unmatched"
  reconciled_at: string | null
  created_at: string
}

export type BillingSummary = {
  currency: string
  invoices: { total: number; open: number; paid: number; draft: number; void: number }
  outstanding: number
  collected: number
  refunded: number
  credit_balance: number
  coupons_active: number
  mrr: number
}

const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "bg-muted text-muted-foreground" },
  open: { label: "Open", tone: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  partially_paid: { label: "Partially paid", tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  paid: { label: "Paid", tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  refunded: { label: "Refunded", tone: "bg-purple-500/15 text-purple-600 dark:text-purple-400" },
  void: { label: "Void", tone: "bg-red-500/15 text-red-600 dark:text-red-400" },
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const meta = INVOICE_STATUS[status] ?? INVOICE_STATUS.draft
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.tone}`}>{meta.label}</span>
  )
}

export function Pill({ children, tone = "bg-muted text-muted-foreground" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{children}</span>
}

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
