import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  tenantSelect,
  tenantInsert,
  tenantUpdate,
  requireOwnedRow,
} from "@/lib/tenant-scope"
import type { SessionPayload } from "@/lib/auth"
import {
  computeInvoice,
  computePlanChange,
  deriveInvoiceStatus,
  evaluateCoupon,
  refundableAmount,
  round2,
  validateRefund,
  type Coupon,
  type DiscountType,
  type InvoiceStatus,
  type LineInput,
} from "@/lib/billing/billing-math"
import {
  getSubscriptionView,
  getPlan,
  planPriceForTerm,
  changePlanRecord,
  ensureSubscriptionSchema,
  loadSubscriptionForChange,
} from "@/lib/billing/subscription-engine"
import { addTerm, canWrite, isBillingTerm, type BillingTerm } from "@/lib/billing/subscription-lifecycle"
import { computeTermChange, couponAllowedForSubscription } from "@/lib/billing/billing-math"
import { currentTenantId } from "@/lib/tenant-scope"
import { computeGstBreakdown } from "@/lib/billing/saas-gst"
import { getSellerGstin, getSellerStateCode, resolvePlaceOfSupply } from "@/lib/billing/saas-seller"
import {
  postInvoiceAccounting,
  postPaymentAccounting,
  postRefundAccounting,
  postCreditGrantAccounting,
} from "@/lib/billing/saas-accounting"

/**
 * Billing engine (data + service layer).
 * ---------------------------------------------------------------------------
 * Owns the money side of the SaaS business: invoices and their line items,
 * coupons, the account credit ledger (credits + adjustments), payments,
 * refunds and gateway reconciliation. It composes the pure financial core
 * (lib/billing/billing-math.ts) with tenant-scoped persistence,
 * validation, authorization (via callers) and an audit trail through each
 * invoice's line/payment/refund children.
 *
 * All tenant-scoped reads/writes go through lib/tenant-scope so they always
 * carry a tenant_id predicate and satisfy the fail-closed guard.
 */

export class BillingError extends Error {
  status: number
  fields?: Record<string, string>
  constructor(message: string, status = 400, fields?: Record<string, string>) {
    super(message)
    this.name = "BillingError"
    this.status = status
    this.fields = fields
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export type InvoiceType = "recurring" | "one_time" | "credit_note"

export type InvoiceLine = {
  id: number
  invoice_id: number
  line_type: "subscription" | "one_time" | "proration" | "adjustment" | "usage"
  description: string
  quantity: number
  unit_amount: number
  amount: number
  taxable: boolean
}

export type Invoice = {
  id: number
  invoice_no: string
  tenant_id: number
  subscription_id: number | null
  customer_name: string
  /** Structured customer billing details, printed on the PDF and used for email delivery. */
  bill_to_email: string | null
  bill_to_company: string | null
  bill_to_tax_id: string | null
  bill_to_address: string | null
  bill_to_city: string | null
  bill_to_state: string | null
  bill_to_postal: string | null
  bill_to_country: string | null
  /** Credit notes reference the invoice they reverse. */
  credit_note_of: number | null
  invoice_type: InvoiceType
  currency: string
  subtotal: number
  discount_total: number
  coupon_code: string | null
  tax_rate: number
  tax_total: number
  seller_gstin: string | null
  place_of_supply: string | null
  place_of_supply_code: string | null
  supply_type: "intra_state" | "inter_state" | null
  igst_total: number
  cgst_total: number
  sgst_total: number
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
  /** Delivery audit: when/where the invoice PDF was last emailed. */
  last_sent_at: string | null
  last_sent_to: string | null
  created_at: string
  updated_at: string
}

export type InvoiceView = Invoice & { lines: InvoiceLine[] }

export type CouponRow = {
  id: number
  coupon_code: string
  name: string
  discount_type: DiscountType
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

// ── Schema (self-healing) ────────────────────────────────────────────────────

let schemaEnsured: Promise<void> | null = null

/**
 * Idempotently add a column to an existing billing table. MySQL lacks
 * `ADD COLUMN IF NOT EXISTS`, so we probe information_schema first. Safe to run
 * on every boot; a no-op once the column exists.
 */
async function ensureBillingColumn(table: string, column: string, definition: string): Promise<void> {
  const rows = (await query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )) as any[]
  if (!rows.length) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

async function ensureBillingIndex(table: string, indexName: string, definition: string): Promise<void> {
  const rows = (await query(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName],
  )) as any[]
  if (!rows.length) {
    await query(`ALTER TABLE \`${table}\` ADD ${definition}`)
  }
}

async function runEnsure(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS billing_coupons (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id        INT UNSIGNED NOT NULL,
    coupon_code      VARCHAR(40) NOT NULL,
    name             VARCHAR(150) NOT NULL,
    discount_type    VARCHAR(10) NOT NULL DEFAULT 'percent',
    value            DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency         VARCHAR(10) NOT NULL DEFAULT 'USD',
    duration         VARCHAR(12) NOT NULL DEFAULT 'once',
    duration_months  INT UNSIGNED DEFAULT NULL,
    min_amount       DECIMAL(14,2) DEFAULT NULL,
    max_redemptions  INT UNSIGNED DEFAULT NULL,
    times_redeemed   INT UNSIGNED NOT NULL DEFAULT 0,
    valid_from       DATE DEFAULT NULL,
    valid_until      DATE DEFAULT NULL,
    is_active        TINYINT(1) NOT NULL DEFAULT 1,
    created_by       INT UNSIGNED DEFAULT NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_billing_coupon_code (tenant_id, coupon_code),
    KEY idx_billing_coupons_tenant (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Billing contacts — the people a tenant designates to receive invoices,
  // dunning and renewal notices. At most one primary per tenant (enforced in
  // the service layer, not the schema, because "primary" moves between rows).
  await query(`CREATE TABLE IF NOT EXISTS billing_contacts (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL,
    name          VARCHAR(190) NOT NULL,
    email         VARCHAR(190) NOT NULL,
    phone         VARCHAR(40) DEFAULT NULL,
    role          VARCHAR(40) NOT NULL DEFAULT 'billing',
    is_primary    TINYINT(1) NOT NULL DEFAULT 0,
    receive_invoices  TINYINT(1) NOT NULL DEFAULT 1,
    receive_dunning   TINYINT(1) NOT NULL DEFAULT 1,
    created_by    INT UNSIGNED DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_billing_contact_email (tenant_id, email),
    KEY idx_billing_contacts_tenant (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS billing_invoices (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
    invoice_no       VARCHAR(30) NOT NULL,
    tenant_id        INT UNSIGNED NOT NULL,
    subscription_id  INT UNSIGNED DEFAULT NULL,
    customer_name    VARCHAR(190) NOT NULL DEFAULT '',
    invoice_type     VARCHAR(20) NOT NULL DEFAULT 'one_time',
    currency         VARCHAR(10) NOT NULL DEFAULT 'USD',
    subtotal         DECIMAL(14,2) NOT NULL DEFAULT 0,
    discount_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
    coupon_code      VARCHAR(40) DEFAULT NULL,
    tax_rate         DECIMAL(7,4) NOT NULL DEFAULT 0,
    tax_total        DECIMAL(14,2) NOT NULL DEFAULT 0,
    credit_applied   DECIMAL(14,2) NOT NULL DEFAULT 0,
    adjustment_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    total            DECIMAL(14,2) NOT NULL DEFAULT 0,
    amount_paid      DECIMAL(14,2) NOT NULL DEFAULT 0,
    amount_refunded  DECIMAL(14,2) NOT NULL DEFAULT 0,
    balance          DECIMAL(14,2) NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'draft',
    issue_date       DATE NOT NULL,
    due_date         DATE DEFAULT NULL,
    period_start     DATE DEFAULT NULL,
    period_end       DATE DEFAULT NULL,
    memo             VARCHAR(500) DEFAULT NULL,
    created_by       INT UNSIGNED DEFAULT NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_billing_invoice_no (invoice_no),
    KEY idx_billing_invoices_tenant (tenant_id),
    KEY idx_billing_inv_status (status),
    KEY idx_billing_inv_sub (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Structured customer billing details + credit-note linkage. Added idempotently
  // so existing installs upgrade in place (MySQL has no ADD COLUMN IF NOT EXISTS).
  await ensureBillingColumn("billing_invoices", "bill_to_email", "VARCHAR(190) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "bill_to_company", "VARCHAR(190) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "bill_to_tax_id", "VARCHAR(60) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "bill_to_address", "VARCHAR(300) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "bill_to_city", "VARCHAR(120) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "bill_to_state", "VARCHAR(120) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "bill_to_postal", "VARCHAR(30) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "bill_to_country", "VARCHAR(120) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "credit_note_of", "INT UNSIGNED DEFAULT NULL")
  // Email delivery audit — when/where the invoice PDF was last sent.
  await ensureBillingColumn("billing_invoices", "last_sent_at", "DATETIME DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "last_sent_to", "VARCHAR(190) DEFAULT NULL")

  // Core money/meta columns. These live in the CREATE TABLE above, but on
  // installs whose `billing_invoices` table predates a given column, the
  // `CREATE TABLE IF NOT EXISTS` is a no-op and never adds it — so an INSERT
  // that writes the column fails with ER_BAD_FIELD_ERROR. Patch them all
  // idempotently (no-op when present) so create/finalize can never 500 on a
  // drifted schema.
  await ensureBillingColumn("billing_invoices", "subscription_id", "INT UNSIGNED DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "customer_name", "VARCHAR(190) NOT NULL DEFAULT ''")
  await ensureBillingColumn("billing_invoices", "invoice_type", "VARCHAR(20) NOT NULL DEFAULT 'one_time'")
  await ensureBillingColumn("billing_invoices", "currency", "VARCHAR(10) NOT NULL DEFAULT 'USD'")
  await ensureBillingColumn("billing_invoices", "subtotal", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "discount_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "coupon_code", "VARCHAR(40) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "tax_rate", "DECIMAL(7,4) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "tax_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "credit_applied", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "adjustment_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "amount_paid", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "amount_refunded", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "balance", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "status", "VARCHAR(20) NOT NULL DEFAULT 'draft'")
  await ensureBillingColumn("billing_invoices", "issue_date", "DATE NULL")
  await ensureBillingColumn("billing_invoices", "due_date", "DATE DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "period_start", "DATE DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "period_end", "DATE DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "memo", "VARCHAR(500) DEFAULT NULL")
  // GST / place-of-supply on SaaS invoices (#81-83).
  await ensureBillingColumn("billing_invoices", "seller_gstin", "VARCHAR(20) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "place_of_supply", "VARCHAR(120) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "place_of_supply_code", "VARCHAR(4) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "supply_type", "VARCHAR(16) DEFAULT NULL")
  await ensureBillingColumn("billing_invoices", "igst_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "cgst_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureBillingColumn("billing_invoices", "sgst_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  await query(`CREATE TABLE IF NOT EXISTS billing_invoice_lines (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL,
    invoice_id    INT UNSIGNED NOT NULL,
    line_type     VARCHAR(20) NOT NULL DEFAULT 'one_time',
    description   VARCHAR(300) NOT NULL DEFAULT '',
    quantity      DECIMAL(14,4) NOT NULL DEFAULT 1,
    unit_amount   DECIMAL(14,4) NOT NULL DEFAULT 0,
    amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
    taxable       TINYINT(1) NOT NULL DEFAULT 1,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_billing_lines_tenant (tenant_id),
    KEY idx_billing_lines_invoice (invoice_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS billing_credits (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL,
    credit_no     VARCHAR(30) NOT NULL,
    entry_type    VARCHAR(12) NOT NULL DEFAULT 'credit',
    reason        VARCHAR(300) NOT NULL DEFAULT '',
    amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
    invoice_id    INT UNSIGNED DEFAULT NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'available',
    created_by    INT UNSIGNED DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_billing_credit_no (credit_no),
    KEY idx_billing_credits_tenant (tenant_id),
    KEY idx_billing_credits_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS billing_payments (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL,
    payment_no    VARCHAR(30) NOT NULL,
    invoice_id    INT UNSIGNED NOT NULL,
    amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
    method        VARCHAR(20) NOT NULL DEFAULT 'manual',
    gateway       VARCHAR(40) DEFAULT NULL,
    reference     VARCHAR(120) DEFAULT NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'succeeded',
    reconciled    TINYINT(1) NOT NULL DEFAULT 0,
    reconciled_at DATETIME DEFAULT NULL,
    paid_at       DATETIME DEFAULT NULL,
    note          VARCHAR(300) DEFAULT NULL,
    created_by    INT UNSIGNED DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_billing_payment_no (payment_no),
    KEY idx_billing_payments_tenant (tenant_id),
    KEY idx_billing_pay_invoice (invoice_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Spec23: idempotent checkout — one pending gateway payment per outstanding
  // balance (see lib/billing/checkout.ts and the 2027-01-15 migration).
  await ensureBillingColumn("billing_payments", "checkout_key", "VARCHAR(120) DEFAULT NULL")
  await ensureBillingIndex("billing_payments", "uq_billing_payments_checkout", "UNIQUE KEY `uq_billing_payments_checkout` (`tenant_id`, `checkout_key`)")

  await query(`CREATE TABLE IF NOT EXISTS billing_refunds (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL,
    refund_no     VARCHAR(30) NOT NULL,
    invoice_id    INT UNSIGNED NOT NULL,
    payment_id    INT UNSIGNED DEFAULT NULL,
    amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
    reason        VARCHAR(300) DEFAULT NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'succeeded',
    refunded_at   DATETIME DEFAULT NULL,
    created_by    INT UNSIGNED DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_billing_refund_no (refund_no),
    KEY idx_billing_refunds_tenant (tenant_id),
    KEY idx_billing_ref_invoice (invoice_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS billing_reconciliation (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL,
    statement_ref VARCHAR(60) NOT NULL,
    gateway       VARCHAR(40) NOT NULL DEFAULT '',
    payout_ref    VARCHAR(120) DEFAULT NULL,
    amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
    payment_id    INT UNSIGNED DEFAULT NULL,
    invoice_no    VARCHAR(30) DEFAULT NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'unmatched',
    reconciled_at DATETIME DEFAULT NULL,
    created_by    INT UNSIGNED DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_billing_recon_tenant (tenant_id),
    KEY idx_billing_recon_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

export async function ensureBillingSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = runEnsure().catch((err) => {
      schemaEnsured = null
      throw err
    })
  }
  return schemaEnsured
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10)
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ")
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const bool = (v: any) => v === true || v === 1 || v === "1" || v === "true"
const dateOf = (v: any) => (v ? String(v).slice(0, 10) : null)

function mapInvoice(r: any): Invoice {
  return {
    id: Number(r.id),
    invoice_no: String(r.invoice_no),
    tenant_id: Number(r.tenant_id),
    subscription_id: r.subscription_id == null ? null : Number(r.subscription_id),
    customer_name: String(r.customer_name ?? ""),
    bill_to_email: r.bill_to_email ?? null,
    bill_to_company: r.bill_to_company ?? null,
    bill_to_tax_id: r.bill_to_tax_id ?? null,
    bill_to_address: r.bill_to_address ?? null,
    bill_to_city: r.bill_to_city ?? null,
    bill_to_state: r.bill_to_state ?? null,
    bill_to_postal: r.bill_to_postal ?? null,
    bill_to_country: r.bill_to_country ?? null,
    credit_note_of: r.credit_note_of == null ? null : Number(r.credit_note_of),
    invoice_type: String(r.invoice_type) as InvoiceType,
    currency: String(r.currency),
    subtotal: num(r.subtotal),
    discount_total: num(r.discount_total),
    coupon_code: r.coupon_code ?? null,
    tax_rate: num(r.tax_rate),
    tax_total: num(r.tax_total),
    seller_gstin: r.seller_gstin ?? null,
    place_of_supply: r.place_of_supply ?? null,
    place_of_supply_code: r.place_of_supply_code ?? null,
    supply_type: (r.supply_type ?? null) as Invoice["supply_type"],
    igst_total: num(r.igst_total),
    cgst_total: num(r.cgst_total),
    sgst_total: num(r.sgst_total),
    credit_applied: num(r.credit_applied),
    adjustment_total: num(r.adjustment_total),
    total: num(r.total),
    amount_paid: num(r.amount_paid),
    amount_refunded: num(r.amount_refunded),
    balance: num(r.balance),
    status: String(r.status) as InvoiceStatus,
    issue_date: dateOf(r.issue_date)!,
    due_date: dateOf(r.due_date),
    period_start: dateOf(r.period_start),
    period_end: dateOf(r.period_end),
    memo: r.memo ?? null,
    last_sent_at: r.last_sent_at ? String(r.last_sent_at) : null,
    last_sent_to: r.last_sent_to ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }
}

function mapLine(r: any): InvoiceLine {
  return {
    id: Number(r.id),
    invoice_id: Number(r.invoice_id),
    line_type: String(r.line_type) as InvoiceLine["line_type"],
    description: String(r.description ?? ""),
    quantity: num(r.quantity),
    unit_amount: num(r.unit_amount),
    amount: num(r.amount),
    taxable: bool(r.taxable),
  }
}

function mapCoupon(r: any): CouponRow {
  return {
    id: Number(r.id),
    coupon_code: String(r.coupon_code),
    name: String(r.name),
    discount_type: String(r.discount_type) as DiscountType,
    value: num(r.value),
    currency: String(r.currency),
    duration: String(r.duration) as CouponRow["duration"],
    duration_months: r.duration_months == null ? null : num(r.duration_months),
    min_amount: r.min_amount == null ? null : num(r.min_amount),
    max_redemptions: r.max_redemptions == null ? null : num(r.max_redemptions),
    times_redeemed: num(r.times_redeemed),
    valid_from: dateOf(r.valid_from),
    valid_until: dateOf(r.valid_until),
    is_active: bool(r.is_active),
    created_at: String(r.created_at),
  }
}

function mapCredit(r: any): CreditEntry {
  return {
    id: Number(r.id),
    credit_no: String(r.credit_no),
    entry_type: String(r.entry_type) as CreditEntry["entry_type"],
    reason: String(r.reason ?? ""),
    amount: num(r.amount),
    currency: String(r.currency),
    invoice_id: r.invoice_id == null ? null : Number(r.invoice_id),
    status: String(r.status) as CreditEntry["status"],
    created_at: String(r.created_at),
  }
}

function mapPayment(r: any): Payment {
  return {
    id: Number(r.id),
    payment_no: String(r.payment_no),
    invoice_id: Number(r.invoice_id),
    amount: num(r.amount),
    currency: String(r.currency),
    method: String(r.method),
    gateway: r.gateway ?? null,
    reference: r.reference ?? null,
    status: String(r.status) as Payment["status"],
    reconciled: bool(r.reconciled),
    paid_at: r.paid_at ? String(r.paid_at) : null,
    note: r.note ?? null,
    created_at: String(r.created_at),
  }
}

function mapRefund(r: any): Refund {
  return {
    id: Number(r.id),
    refund_no: String(r.refund_no),
    invoice_id: Number(r.invoice_id),
    payment_id: r.payment_id == null ? null : Number(r.payment_id),
    amount: num(r.amount),
    currency: String(r.currency),
    reason: r.reason ?? null,
    status: String(r.status) as Refund["status"],
    refunded_at: r.refunded_at ? String(r.refunded_at) : null,
    created_at: String(r.created_at),
  }
}

function mapRecon(r: any): ReconEntry {
  return {
    id: Number(r.id),
    statement_ref: String(r.statement_ref),
    gateway: String(r.gateway ?? ""),
    payout_ref: r.payout_ref ?? null,
    amount: num(r.amount),
    currency: String(r.currency),
    payment_id: r.payment_id == null ? null : Number(r.payment_id),
    invoice_no: r.invoice_no ?? null,
    status: String(r.status) as ReconEntry["status"],
    reconciled_at: r.reconciled_at ? String(r.reconciled_at) : null,
    created_at: String(r.created_at),
  }
}

// ── Account credit balance ────────────────────────────────────────────────────

/**
 * The tenant's spendable credit balance: available credits/adjustments minus
 * consumed debits. Adjustment entries may be signed (a negative adjustment is
 * a debit against the balance).
 */
export async function creditBalance(): Promise<number> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_credits", {
    columns: "entry_type, amount, status",
    where: "status != 'void'",
  })) as any[]
  let balance = 0
  for (const r of rows) {
    const amt = num(r.amount)
    if (r.entry_type === "debit") balance -= Math.abs(amt)
    else balance += amt
  }
  return round2(balance)
}

// ── Billing contacts ──────────────────────────────────────────────────────────

export type BillingContact = {
  id: number
  tenant_id: number
  name: string
  email: string
  phone: string | null
  role: string
  is_primary: boolean
  receive_invoices: boolean
  receive_dunning: boolean
  created_at: string
  updated_at: string
}

export type BillingContactInput = {
  name?: string
  email?: string
  phone?: string | null
  role?: string
  is_primary?: boolean
  receive_invoices?: boolean
  receive_dunning?: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function mapContact(r: any): BillingContact {
  return {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    name: String(r.name ?? ""),
    email: String(r.email ?? ""),
    phone: r.phone ?? null,
    role: String(r.role ?? "billing"),
    is_primary: bool(r.is_primary),
    receive_invoices: bool(r.receive_invoices),
    receive_dunning: bool(r.receive_dunning),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }
}

export async function listBillingContacts(): Promise<BillingContact[]> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_contacts", {
    tail: "ORDER BY is_primary DESC, name ASC",
  })) as any[]
  return rows.map(mapContact)
}

function validateContact(input: BillingContactInput, partial = false): Record<string, string> {
  const fields: Record<string, string> = {}
  if (!partial || input.name !== undefined) {
    if (!String(input.name ?? "").trim()) fields.name = "Name is required."
  }
  if (!partial || input.email !== undefined) {
    const email = String(input.email ?? "").trim()
    if (!email) fields.email = "Email is required."
    else if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address."
  }
  return fields
}

/**
 * Ensure at most one primary contact per tenant. Called inside a create/update
 * that sets is_primary=true; demotes every other row for the tenant first. The
 * tenant scope guard means this can only ever touch the caller's own rows.
 */
async function clearOtherPrimaries(exceptId: number | null): Promise<void> {
  if (exceptId != null) {
    await tenantUpdate("billing_contacts", { is_primary: 0 }, "is_primary = 1 AND id <> ?", [exceptId])
  } else {
    await tenantUpdate("billing_contacts", { is_primary: 0 }, "is_primary = 1")
  }
}

export async function createBillingContact(
  input: BillingContactInput,
  session: SessionPayload,
): Promise<BillingContact> {
  await ensureBillingSchema()
  const fields = validateContact(input)
  if (Object.keys(fields).length) throw new BillingError("Validation failed", 400, fields)

  const email = String(input.email).trim().toLowerCase()
  const dup = (await tenantSelect("billing_contacts", {
    columns: "id",
    where: "email = ?",
    params: [email],
  })) as any[]
  if (dup.length) {
    throw new BillingError("A contact with that email already exists.", 409, {
      email: "Email already in use.",
    })
  }

  const makePrimary = input.is_primary === true
  if (makePrimary) await clearOtherPrimaries(null)

  const { insertId } = await tenantInsert("billing_contacts", {
    name: String(input.name).trim(),
    email,
    phone: input.phone ? String(input.phone).trim() : null,
    role: String(input.role || "billing").trim(),
    is_primary: makePrimary ? 1 : 0,
    receive_invoices: input.receive_invoices === false ? 0 : 1,
    receive_dunning: input.receive_dunning === false ? 0 : 1,
    created_by: session.userId ?? null,
  })
  const row = await requireOwnedRow("billing_contacts", insertId)
  return mapContact(row)
}

export async function updateBillingContact(
  id: number,
  input: BillingContactInput,
  _session: SessionPayload,
): Promise<BillingContact> {
  await ensureBillingSchema()
  // Ownership assertion — cross-tenant ids are refused here (404-equivalent).
  await requireOwnedRow("billing_contacts", id)

  const fields = validateContact(input, true)
  if (Object.keys(fields).length) throw new BillingError("Validation failed", 400, fields)

  const patch: Record<string, any> = {}
  if (input.name !== undefined) patch.name = String(input.name).trim()
  if (input.email !== undefined) {
    const email = String(input.email).trim().toLowerCase()
    const dup = (await tenantSelect("billing_contacts", {
      columns: "id",
      where: "email = ? AND id <> ?",
      params: [email, id],
    })) as any[]
    if (dup.length) {
      throw new BillingError("A contact with that email already exists.", 409, {
        email: "Email already in use.",
      })
    }
    patch.email = email
  }
  if (input.phone !== undefined) patch.phone = input.phone ? String(input.phone).trim() : null
  if (input.role !== undefined) patch.role = String(input.role || "billing").trim()
  if (input.receive_invoices !== undefined) patch.receive_invoices = input.receive_invoices ? 1 : 0
  if (input.receive_dunning !== undefined) patch.receive_dunning = input.receive_dunning ? 1 : 0
  if (input.is_primary !== undefined) {
    patch.is_primary = input.is_primary ? 1 : 0
    if (input.is_primary) await clearOtherPrimaries(id)
  }

  if (Object.keys(patch).length) await tenantUpdate("billing_contacts", patch, "id = ?", [id])
  const row = await requireOwnedRow("billing_contacts", id)
  return mapContact(row)
}

export async function deleteBillingContact(id: number): Promise<void> {
  await ensureBillingSchema()
  await requireOwnedRow("billing_contacts", id)
  const { tenantDelete } = await import("@/lib/tenant-scope")
  await tenantDelete("billing_contacts", "id = ?", [id])
}

// ── Coupons ��────────────────────────────────────────────────────────────────

export async function listCoupons(): Promise<CouponRow[]> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_coupons", { tail: "ORDER BY created_at DESC" })) as any[]
  return rows.map(mapCoupon)
}

export type CouponInput = {
  code?: string
  name?: string
  discount_type?: DiscountType
  value?: number | string
  currency?: string
  duration?: "once" | "forever" | "repeating"
  duration_months?: number | string | null
  min_amount?: number | string | null
  max_redemptions?: number | string | null
  valid_from?: string | null
  valid_until?: string | null
  is_active?: boolean
}

export async function createCoupon(input: CouponInput, session: SessionPayload): Promise<CouponRow> {
  await ensureBillingSchema()
  const fields: Record<string, string> = {}
  const code = String(input.code ?? "").trim().toUpperCase()
  if (!code) fields.code = "Coupon code is required."
  if (!String(input.name ?? "").trim()) fields.name = "Name is required."
  const type: DiscountType = input.discount_type === "fixed" ? "fixed" : "percent"
  const value = num(input.value)
  if (value <= 0) fields.value = "Discount value must be greater than zero."
  if (type === "percent" && value > 100) fields.value = "Percentage cannot exceed 100."
  if (Object.keys(fields).length) throw new BillingError("Validation failed", 400, fields)

  const dup = (await tenantSelect("billing_coupons", {
    columns: "id",
    where: "coupon_code = ?",
    params: [code],
  })) as any[]
  if (dup.length) {
    throw new BillingError("A coupon with that code already exists.", 409, { code: "Code already in use." })
  }

  const { insertId } = await tenantInsert("billing_coupons", {
    coupon_code: code,
    name: String(input.name).trim(),
    discount_type: type,
    value: round2(value),
    currency: String(input.currency || "USD").trim(),
    duration: input.duration ?? "once",
    duration_months: input.duration_months ? num(input.duration_months) : null,
    min_amount:
      input.min_amount === null || input.min_amount === undefined || input.min_amount === ("" as any)
        ? null
        : round2(num(input.min_amount)),
    max_redemptions: input.max_redemptions ? num(input.max_redemptions) : null,
    valid_from: input.valid_from || null,
    valid_until: input.valid_until || null,
    is_active: input.is_active === false ? 0 : 1,
    created_by: session.userId,
  })
  const created = await requireOwnedRow("billing_coupons", insertId)
  return mapCoupon(created)
}

export async function setCouponActive(id: number, isActive: boolean): Promise<void> {
  await ensureBillingSchema()
  await requireOwnedRow("billing_coupons", id)
  await tenantUpdate("billing_coupons", { is_active: isActive ? 1 : 0 }, "id = ?", [id])
}

export async function findCouponByCode(code: string): Promise<CouponRow | null> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_coupons", {
    where: "coupon_code = ?",
    params: [String(code).trim().toUpperCase()],
    tail: "LIMIT 1",
  })) as any[]
  return rows[0] ? mapCoupon(rows[0]) : null
}

// ── Credits & adjustments ─────────────────────────────────────────────────────

export async function listCredits(): Promise<CreditEntry[]> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_credits", { tail: "ORDER BY created_at DESC" })) as any[]
  return rows.map(mapCredit)
}

export type CreditInput = {
  entry_type?: "credit" | "debit" | "adjustment"
  reason?: string
  amount?: number | string
  currency?: string
}

export async function createCredit(input: CreditInput, session: SessionPayload): Promise<CreditEntry> {
  await ensureBillingSchema()
  const entryType =
    input.entry_type === "debit" ? "debit" : input.entry_type === "adjustment" ? "adjustment" : "credit"
  const amount = round2(num(input.amount))
  if (amount === 0) throw new BillingError("Amount cannot be zero.", 400, { amount: "Enter a non-zero amount." })
  if (entryType !== "adjustment" && amount <= 0) {
    throw new BillingError("Amount must be greater than zero.", 400, { amount: "Enter a positive amount." })
  }
  const creditNo = await nextRecordId("CRN", { digits: 5, allowCustom: true })
  const { insertId } = await tenantInsert("billing_credits", {
    credit_no: creditNo,
    entry_type: entryType,
    reason: String(input.reason ?? "").trim(),
    amount,
    currency: String(input.currency || "USD").trim(),
    invoice_id: null,
    status: "available",
    created_by: session.userId,
  })
  const created = await requireOwnedRow("billing_credits", insertId)
  // Book granted account credit to the platform seller ledger. Only positive
  // credit grants are booked; debits/adjustments are internal ledger movements.
  if (entryType === "credit" && amount > 0) {
    await postCreditGrantAccounting({ id: Number(insertId), amount }, session).catch((e) =>
      console.log("[v0] credit accounting post failed", (e as Error).message),
    )
  }
  return mapCredit(created)
}

/** Record a debit against the credit ledger (credit consumed by an invoice). */
async function consumeCredit(amount: number, invoiceId: number, session: SessionPayload): Promise<void> {
  if (amount <= 0) return
  const creditNo = await nextRecordId("CRN", { digits: 5, allowCustom: true })
  await tenantInsert("billing_credits", {
    credit_no: creditNo,
    entry_type: "debit",
    reason: `Applied to invoice #${invoiceId}`,
    amount: round2(amount),
    currency: "USD",
    invoice_id: invoiceId,
    status: "applied",
    created_by: session.userId,
  })
}

// ── Invoices: reads ──────────────────────────────────────────────────────────

export async function listInvoices(): Promise<Invoice[]> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_invoices", { tail: "ORDER BY created_at DESC" })) as any[]
  return rows.map(mapInvoice)
}

async function loadLines(invoiceId: number): Promise<InvoiceLine[]> {
  const rows = (await tenantSelect("billing_invoice_lines", {
    where: "invoice_id = ?",
    params: [invoiceId],
    tail: "ORDER BY id ASC",
  })) as any[]
  return rows.map(mapLine)
}

export async function getInvoice(id: number): Promise<InvoiceView | null> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_invoices", {
    where: "id = ?",
    params: [id],
    tail: "LIMIT 1",
  })) as any[]
  if (!rows[0]) return null
  const invoice = mapInvoice(rows[0])
  return { ...invoice, lines: await loadLines(invoice.id) }
}

export async function listPayments(invoiceId: number): Promise<Payment[]> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_payments", {
    where: "invoice_id = ?",
    params: [invoiceId],
    tail: "ORDER BY created_at ASC",
  })) as any[]
  return rows.map(mapPayment)
}

// ── Invoices: creation ─────────────────────────────────────────────────────────

export type CreateInvoiceInput = {
  invoice_type?: InvoiceType
  subscription_id?: number | null
  customer_name?: string
  bill_to_email?: string | null
  bill_to_company?: string | null
  bill_to_tax_id?: string | null
  bill_to_address?: string | null
  bill_to_city?: string | null
  bill_to_state?: string | null
  bill_to_postal?: string | null
  bill_to_country?: string | null
  currency?: string
  lines?: Array<{
    description?: string
    quantity?: number | string
    unit_amount?: number | string
    taxable?: boolean
    line_type?: InvoiceLine["line_type"]
  }>
  discount_type?: DiscountType | null
  discount_value?: number | string | null
  coupon_code?: string | null
  tax_rate?: number | string
  adjustment?: number | string
  apply_credit?: boolean
  due_date?: string | null
  period_start?: string | null
  period_end?: string | null
  memo?: string | null
  /** When true, finalize immediately (open/paid) instead of leaving a draft. */
  finalize?: boolean
}

/**
 * Create an invoice from raw lines plus modifiers. Runs the full money
 * breakdown through the pure core, optionally consumes account credit,
 * increments coupon redemption, and persists the header + lines.
 */
export async function createInvoice(input: CreateInvoiceInput, session: SessionPayload): Promise<InvoiceView> {
  await ensureBillingSchema()

  const rawLines: LineInput[] = (input.lines ?? []).map((l) => ({
    description: String(l.description ?? "").trim(),
    quantity: num(l.quantity ?? 1),
    unitAmount: num(l.unit_amount ?? 0),
    taxable: l.taxable !== false,
    lineType: (l.line_type ?? "one_time") as LineInput["lineType"],
  }))
  if (rawLines.length === 0) {
    throw new BillingError("An invoice needs at least one line item.", 400, { lines: "Add at least one line." })
  }

  const currency = String(input.currency || "USD").trim()
  const subtotalPreview = round2(rawLines.reduce((s, l) => s + round2(Number(l.quantity) * Number(l.unitAmount)), 0))

  // Coupon (optional) — evaluated against the pre-discount subtotal.
  let coupon: CouponRow | null = null
  let couponDiscount = 0
  if (input.coupon_code) {
    coupon = await findCouponByCode(input.coupon_code)
    const ev = evaluateCoupon(coupon as unknown as Coupon | null, subtotalPreview, { onDate: today(), currency })
    if (!ev.applicable) {
      throw new BillingError(ev.reason ?? "Coupon is not applicable.", 400, { coupon_code: ev.reason ?? "Invalid coupon." })
    }
    couponDiscount = ev.discount
    if (input.subscription_id && coupon) {
      const prior = (await tenantSelect("billing_invoices", {
        columns: "COUNT(*) AS n",
        where: "subscription_id = ? AND coupon_code = ? AND status <> 'void'",
        params: [input.subscription_id, coupon.coupon_code],
      })) as any[]
      const allowed = couponAllowedForSubscription(coupon.duration, num(prior[0]?.n))
      if (!allowed.ok) {
        throw new BillingError(allowed.reason ?? "Coupon is not applicable.", 409, { coupon_code: allowed.reason ?? "" })
      }
    }
    // Atomic reservation: the conditional UPDATE is the single source of truth
    // for max_redemptions, so two concurrent checkouts cannot both take the last
    // redemption (the evaluateCoupon check above is only a friendly pre-check).
    const reserved = await reserveCouponRedemption(coupon!.id)
    if (!reserved) {
      throw new BillingError("This coupon has reached its redemption limit.", 409, {
        coupon_code: "Redemption limit reached.",
      })
    }
  }

  try {
    return await createInvoiceWithReservedCoupon(input, session, rawLines, currency, coupon, couponDiscount)
  } catch (err) {
    if (coupon) await releaseCouponRedemption(coupon.id).catch(() => {})
    throw err
  }
}

/** Claim one redemption slot. Returns false when the cap is already reached. */
export async function reserveCouponRedemption(couponId: number): Promise<boolean> {
  const res = await query<any>(
    `UPDATE billing_coupons SET times_redeemed = times_redeemed + 1
      WHERE tenant_id = ? AND id = ? AND is_active = 1
        AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)`,
    [currentTenantId(), couponId],
  )
  return Number(res?.affectedRows ?? 0) === 1
}

async function releaseCouponRedemption(couponId: number): Promise<void> {
  await query(
    `UPDATE billing_coupons SET times_redeemed = GREATEST(times_redeemed - 1, 0) WHERE tenant_id = ? AND id = ?`,
    [currentTenantId(), couponId],
  )
}

async function createInvoiceWithReservedCoupon(
  input: CreateInvoiceInput,
  session: SessionPayload,
  rawLines: LineInput[],
  currency: string,
  coupon: CouponRow | null,
  couponDiscount: number,
): Promise<InvoiceView> {
  const applyCreditFlag = input.apply_credit === true
  const available = applyCreditFlag ? await creditBalance() : 0

  const totals = computeInvoice({
    lines: rawLines,
    discount:
      input.discount_type && input.discount_value != null
        ? { type: input.discount_type, value: num(input.discount_value) }
        : null,
    couponDiscount,
    taxRatePercent: num(input.tax_rate),
    adjustment: num(input.adjustment),
    creditAvailable: available,
  })

  const finalize = input.finalize !== false // default: finalize on create
  const status = deriveInvoiceStatus(
    { total: totals.total, amountPaid: 0, amountRefunded: 0, creditApplied: totals.creditApplied },
    { finalized: finalize },
  )

  // GST breakdown for the SaaS invoice: place of supply from the customer's
  // GSTIN (or billing state) drives the intra- vs inter-state split of the
  // computed tax total into IGST or CGST+SGST.
  const sellerGstin = getSellerGstin()
  const placeOfSupply = resolvePlaceOfSupply({ taxId: input.bill_to_tax_id, state: input.bill_to_state })
  const gst = computeGstBreakdown({
    taxTotal: totals.taxTotal,
    ratePercent: num(input.tax_rate),
    sellerStateCode: getSellerStateCode(),
    placeOfSupplyStateCode: placeOfSupply.code,
  })

  const invoiceNo = await nextRecordId("BINV", { digits: 5, allowCustom: true })
  const { insertId } = await tenantInsert("billing_invoices", {
    invoice_no: invoiceNo,
    subscription_id: input.subscription_id ?? null,
    customer_name: String(input.customer_name ?? "").trim(),
    bill_to_email: input.bill_to_email?.trim() || null,
    bill_to_company: input.bill_to_company?.trim() || null,
    bill_to_tax_id: input.bill_to_tax_id?.trim() || null,
    bill_to_address: input.bill_to_address?.trim() || null,
    bill_to_city: input.bill_to_city?.trim() || null,
    bill_to_state: input.bill_to_state?.trim() || null,
    bill_to_postal: input.bill_to_postal?.trim() || null,
    bill_to_country: input.bill_to_country?.trim() || null,
    invoice_type: input.invoice_type ?? "one_time",
    currency,
    subtotal: totals.subtotal,
    discount_total: totals.discountTotal,
    coupon_code: coupon?.coupon_code ?? null,
    tax_rate: num(input.tax_rate),
    tax_total: totals.taxTotal,
    seller_gstin: sellerGstin || null,
    place_of_supply: placeOfSupply.name,
    place_of_supply_code: placeOfSupply.code,
    supply_type: gst.supplyType,
    igst_total: gst.igst,
    cgst_total: gst.cgst,
    sgst_total: gst.sgst,
    credit_applied: totals.creditApplied,
    adjustment_total: totals.adjustmentTotal,
    total: totals.total,
    amount_paid: 0,
    amount_refunded: 0,
    balance: totals.amountDue,
    status,
    issue_date: today(),
    due_date: input.due_date || null,
    period_start: input.period_start || null,
    period_end: input.period_end || null,
    memo: input.memo || null,
    created_by: session.userId,
  })

  // Persist lines.
  for (const l of rawLines) {
    const amount = round2(Number(l.quantity) * Number(l.unitAmount))
    await tenantInsert("billing_invoice_lines", {
      invoice_id: insertId,
      line_type: l.lineType ?? "one_time",
      description: l.description ?? "",
      quantity: Number(l.quantity),
      unit_amount: Number(l.unitAmount),
      amount,
      taxable: l.taxable !== false ? 1 : 0,
    })
  }

  // Consume credit after the invoice exists (coupon slot was reserved up front).
  if (totals.creditApplied > 0) await consumeCredit(totals.creditApplied, insertId, session)

  const created = await getInvoice(insertId)
  if (!created) throw new BillingError("Failed to load the invoice just created", 500)
  // Post to the platform seller ledger (and defer multi-month revenue).
  // Best-effort: a ledger hiccup must never block issuing the invoice, and the
  // posting is idempotent so a later retry still books it exactly once.
  if (created.status !== "draft") {
    await postInvoiceAccounting(created, session).catch((e) =>
      console.log("[v0] invoice accounting post failed", (e as Error).message),
    )
  }
  return created
}

// ── Invoices: money mutations ────────────────────────────────────────────────

/** Recompute amount_paid / amount_refunded / balance / status from children. */
export async function recomputeInvoice(invoiceId: number): Promise<void> {
  const inv = await getInvoice(invoiceId)
  if (!inv) return
  const payRows = (await tenantSelect("billing_payments", {
    columns: "amount, status",
    where: "invoice_id = ? AND status = 'succeeded'",
    params: [invoiceId],
  })) as any[]
  const refundRows = (await tenantSelect("billing_refunds", {
    columns: "amount, status",
    where: "invoice_id = ? AND status = 'succeeded'",
    params: [invoiceId],
  })) as any[]
  const amountPaid = round2(payRows.reduce((s, r) => s + num(r.amount), 0))
  const amountRefunded = round2(refundRows.reduce((s, r) => s + num(r.amount), 0))

  const sticky = inv.status === "void" ? "void" : inv.status === "uncollectible" ? "uncollectible" : null
  const finalized = inv.status !== "draft"
  const status = deriveInvoiceStatus(
    { total: inv.total, amountPaid, amountRefunded, creditApplied: inv.credit_applied },
    { finalized, sticky },
  )
  // Balance owed = total − credit − paid (never negative for display).
  const balance = round2(Math.max(0, inv.total - inv.credit_applied - amountPaid))
  await tenantUpdate(
    "billing_invoices",
    { amount_paid: amountPaid, amount_refunded: amountRefunded, balance, status },
    "id = ?",
    [invoiceId],
  )
}

export type PaymentInput = {
  amount?: number | string
  method?: string
  gateway?: string | null
  reference?: string | null
  status?: "succeeded" | "pending" | "failed"
  note?: string | null
}

export async function recordPayment(invoiceId: number, input: PaymentInput, session: SessionPayload): Promise<Payment> {
  await ensureBillingSchema()
  const inv = await getInvoice(invoiceId)
  if (!inv) throw new BillingError("Invoice not found", 404)
  if (inv.status === "void") throw new BillingError("Cannot pay a void invoice.", 409)
  if (inv.status === "draft") throw new BillingError("Finalize the invoice before recording a payment.", 409)

  const status = input.status ?? "succeeded"
  const outstanding = round2(Math.max(0, inv.total - inv.credit_applied - inv.amount_paid))
  const amount = round2(num(input.amount) || outstanding)
  if (amount <= 0) throw new BillingError("Payment amount must be greater than zero.", 400, { amount: "Enter an amount." })
  if (status === "succeeded" && amount > outstanding + 0.0001) {
    throw new BillingError(`Payment exceeds the outstanding balance of ${outstanding}.`, 400, {
      amount: `Max ${outstanding}.`,
    })
  }

  const paymentNo = await nextRecordId("BPAY", { digits: 5, allowCustom: true })
  const { insertId } = await tenantInsert("billing_payments", {
    payment_no: paymentNo,
    invoice_id: invoiceId,
    amount,
    currency: inv.currency,
    method: String(input.method || "manual"),
    gateway: input.gateway || null,
    reference: input.reference || null,
    status,
    reconciled: 0,
    paid_at: status === "succeeded" ? now() : null,
    note: input.note || null,
    created_by: session.userId,
  })
  await recomputeInvoice(invoiceId)
  const created = await requireOwnedRow("billing_payments", insertId)
  // Book the cash receipt to the platform seller ledger (idempotent, best-effort).
  if (status === "succeeded") {
    await postPaymentAccounting(
      { id: Number(created.id), amount, paid_at: created.paid_at, invoice_no: inv.invoice_no },
      session,
    ).catch((e) => console.log("[v0] payment accounting post failed", (e as Error).message))
  }
  return mapPayment(created)
}

/** Stamp the email-delivery audit fields after a successful send. */
export async function markInvoiceSent(invoiceId: number, to: string): Promise<void> {
  await ensureBillingSchema()
  await requireOwnedRow("billing_invoices", invoiceId)
  await tenantUpdate("billing_invoices", { last_sent_at: now(), last_sent_to: to }, "id = ?", [invoiceId])
}

export async function finalizeInvoice(invoiceId: number): Promise<InvoiceView> {
  await ensureBillingSchema()
  const inv = await getInvoice(invoiceId)
  if (!inv) throw new BillingError("Invoice not found", 404)
  if (inv.status !== "draft") return inv
  await tenantUpdate("billing_invoices", { status: "open" }, "id = ?", [invoiceId])
  await recomputeInvoice(invoiceId)
  return (await getInvoice(invoiceId))!
}

export async function voidInvoice(invoiceId: number): Promise<InvoiceView> {
  await ensureBillingSchema()
  const inv = await getInvoice(invoiceId)
  if (!inv) throw new BillingError("Invoice not found", 404)
  if (inv.amount_paid > 0) {
    throw new BillingError("Cannot void an invoice with payments. Refund it instead.", 409)
  }
  await tenantUpdate("billing_invoices", { status: "void", balance: 0 }, "id = ?", [invoiceId])
  return (await getInvoice(invoiceId))!
}

export type RefundInput = {
  amount?: number | string
  reason?: string | null
  payment_id?: number | null
  /** When true, issue the refunded amount as account credit instead of cash. */
  as_credit?: boolean
}

export async function refundInvoice(invoiceId: number, input: RefundInput, session: SessionPayload): Promise<Refund> {
  await ensureBillingSchema()
  const inv = await getInvoice(invoiceId)
  if (!inv) throw new BillingError("Invoice not found", 404)

  const check = validateRefund(num(input.amount) || inv.amount_paid - inv.amount_refunded, {
    amountPaid: inv.amount_paid,
    amountRefunded: inv.amount_refunded,
  })
  if (!check.ok) throw new BillingError(check.reason ?? "Invalid refund.", 400, { amount: check.reason ?? "Invalid refund." })

  const refundNo = await nextRecordId("BREF", { digits: 5, allowCustom: true })
  const { insertId } = await tenantInsert("billing_refunds", {
    refund_no: refundNo,
    invoice_id: invoiceId,
    payment_id: input.payment_id ?? null,
    amount: check.amount,
    currency: inv.currency,
    reason: input.reason || null,
    status: "succeeded",
    refunded_at: now(),
    created_by: session.userId,
  })
  await recomputeInvoice(invoiceId)

  // Optionally return the money as account credit for future invoices.
  if (input.as_credit) {
    await createCredit(
      { entry_type: "credit", reason: `Refund credit for invoice ${inv.invoice_no}`, amount: check.amount, currency: inv.currency },
      session,
    )
  }

  // Book the refund to the platform seller ledger (idempotent, best-effort).
  await postRefundAccounting(
    { id: Number(insertId), amount: check.amount, as_credit: Boolean(input.as_credit) },
    session,
  ).catch((e) => console.log("[v0] refund accounting post failed", (e as Error).message))

  const created = await requireOwnedRow("billing_refunds", insertId)
  return mapRefund(created)
}

export type CreditNoteInput = {
  /** Optional specific lines to credit; when omitted, the whole invoice is reversed. */
  lines?: Array<{ description?: string; quantity?: number | string; unit_amount?: number | string; taxable?: boolean }>
  reason?: string | null
  /** When true, also post the credit-note total to the tenant's account credit ledger. */
  as_account_credit?: boolean
}

/**
 * Issue a credit note against a finalized invoice. A credit note is a separate,
 * finalized `credit_note` invoice whose line amounts mirror the original (as
 * negative-value reversals) so the ledger stays balanced. It never mutates the
 * source invoice; it references it via `credit_note_of`. Optionally the net
 * value is posted to account credit for use on future invoices.
 */
export async function issueCreditNote(
  invoiceId: number,
  input: CreditNoteInput,
  session: SessionPayload,
): Promise<InvoiceView> {
  await ensureBillingSchema()
  const source = await getInvoice(invoiceId)
  if (!source) throw new BillingError("Invoice not found", 404)
  if (source.invoice_type === "credit_note") {
    throw new BillingError("Cannot issue a credit note against another credit note.", 409)
  }
  if (source.status === "draft") {
    throw new BillingError("Finalize the invoice before issuing a credit note.", 409)
  }

  // Reverse either the requested lines or the full invoice. Amounts are stored
  // as negatives so the credit note's total is a negative of what it reverses.
  const reversalLines =
    input.lines && input.lines.length > 0
      ? input.lines.map((l) => ({
          description: String(l.description ?? "Credit").trim() || "Credit",
          quantity: num(l.quantity ?? 1),
          unit_amount: -Math.abs(num(l.unit_amount ?? 0)),
          taxable: l.taxable !== false,
          line_type: "adjustment" as InvoiceLine["line_type"],
        }))
      : source.lines.map((l) => ({
          description: `Credit — ${l.description}`,
          quantity: l.quantity,
          unit_amount: -Math.abs(l.unit_amount),
          taxable: l.taxable,
          line_type: "adjustment" as InvoiceLine["line_type"],
        }))

  if (reversalLines.length === 0) {
    throw new BillingError("Nothing to credit on this invoice.", 400)
  }

  const creditNote = await createInvoice(
    {
      invoice_type: "credit_note",
      subscription_id: source.subscription_id,
      customer_name: source.customer_name,
      bill_to_email: source.bill_to_email,
      bill_to_company: source.bill_to_company,
      bill_to_tax_id: source.bill_to_tax_id,
      bill_to_address: source.bill_to_address,
      bill_to_city: source.bill_to_city,
      bill_to_state: source.bill_to_state,
      bill_to_postal: source.bill_to_postal,
      bill_to_country: source.bill_to_country,
      currency: source.currency,
      tax_rate: source.tax_rate,
      memo: input.reason?.trim() || `Credit note for invoice ${source.invoice_no}`,
      finalize: true,
      lines: reversalLines,
    },
    session,
  )

  // Link the credit note back to the invoice it reverses.
  await tenantUpdate("billing_invoices", { credit_note_of: source.id }, "id = ?", [creditNote.id])

  // Optionally return the reversed value to the account credit ledger. The
  // credit-note total is negative, so the posted credit is its absolute value.
  if (input.as_account_credit) {
    const creditValue = round2(Math.abs(creditNote.total))
    if (creditValue > 0) {
      await createCredit(
        {
          entry_type: "credit",
          reason: `Credit note ${creditNote.invoice_no} for invoice ${source.invoice_no}`,
          amount: creditValue,
          currency: source.currency,
        },
        session,
      )
    }
  }

  return (await getInvoice(creditNote.id))!
}

/**
 * All refunds across the tenant, enriched with their invoice number and
 * customer so the refunds console can render without per-row lookups.
 */
export async function listRefunds(): Promise<
  Array<Refund & { invoice_no: string | null; customer_name: string | null }>
> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_refunds", { tail: "ORDER BY created_at DESC" })) as any[]
  const refunds = rows.map(mapRefund)
  if (refunds.length === 0) return []
  const invRows = (await tenantSelect("billing_invoices", {
    columns: "id, invoice_no, customer_name",
  })) as any[]
  const byId = new Map<number, any>(invRows.map((r) => [Number(r.id), r]))
  return refunds.map((r) => {
    const inv = byId.get(r.invoice_id)
    return {
      ...r,
      invoice_no: inv ? String(inv.invoice_no) : null,
      customer_name: inv ? String(inv.customer_name) : null,
    }
  })
}

// ���─ Recurring billing / invoice generation from subscriptions ─────────────────

/**
 * Generate a recurring invoice for a subscription's current period. Idempotent
 * per (subscription, period_start): if an invoice already exists for that
 * period it is returned rather than duplicated.
 */
export async function generateSubscriptionInvoice(
  subscriptionId: number,
  session: SessionPayload,
  opts: { taxRate?: number } = {},
): Promise<{ invoice: InvoiceView; created: boolean }> {
  await ensureBillingSchema()
  const sub = await getSubscriptionView(subscriptionId)
  if (!sub) throw new BillingError("Subscription not found", 404)

  const existing = (await tenantSelect("billing_invoices", {
    columns: "id",
    where: "subscription_id = ? AND period_start = ?",
    params: [subscriptionId, sub.current_period_start],
    tail: "LIMIT 1",
  })) as any[]
  if (existing[0]) {
    const inv = await getInvoice(Number(existing[0].id))
    return { invoice: inv!, created: false }
  }

  const invoice = await createInvoice(
    {
      invoice_type: "recurring",
      subscription_id: subscriptionId,
      customer_name: sub.plan_name,
      currency: sub.currency,
      tax_rate: opts.taxRate ?? 0,
      period_start: sub.current_period_start,
      period_end: sub.current_period_end,
      due_date: sub.current_period_end,
      finalize: true,
      lines: [
        {
          description: `${sub.plan_name} — ${sub.term_label} (${sub.current_period_start} to ${sub.current_period_end})`,
          quantity: 1,
          unit_amount: sub.amount,
          taxable: true,
          line_type: "subscription",
        },
      ],
    },
    session,
  )
  return { invoice, created: true }
}

/**
 * Run recurring billing across every active subscription whose current period
 * has an invoice due. Returns a summary of what was generated.
 */
export async function runRecurringBilling(
  session: SessionPayload,
  opts: { taxRate?: number } = {},
): Promise<{ generated: number; skipped: number; invoiceNos: string[] }> {
  await ensureBillingSchema()
  // The subscription tables are owned by the subscription engine. Ensure they
  // exist before we read them so a fresh install (no subscription created yet)
  // doesn't 500 on a missing `saas_subscriptions` table.
  await ensureSubscriptionSchema()
  const subs = (await tenantSelect("saas_subscriptions", {
    columns: "id, status",
    where: "status IN ('active','trial','past_due','grace')",
  })) as any[]
  let generated = 0
  let skipped = 0
  const invoiceNos: string[] = []
  for (const s of subs) {
    try {
      const res = await generateSubscriptionInvoice(Number(s.id), session, opts)
      if (res.created) {
        generated++
        invoiceNos.push(res.invoice.invoice_no)
      } else {
        skipped++
      }
    } catch (e) {
      console.log("[v0] recurring billing failed for subscription", s.id, (e as Error).message)
      skipped++
    }
  }
  return { generated, skipped, invoiceNos }
}

/**
 * Apply an immediate mid-cycle plan change to a subscription and produce the
 * prorated invoice (upgrade → charge now) or account credit (downgrade).
 */
export async function applyPlanChangeProration(
  subscriptionId: number,
  newAmount: number,
  session: SessionPayload,
  opts: { taxRate?: number; termChanged?: boolean; unpaidTrial?: boolean } = {},
): Promise<{ result: ReturnType<typeof computePlanChange>; invoice: InvoiceView | null; credit: CreditEntry | null }> {
  await ensureBillingSchema()
  const sub = await getSubscriptionView(subscriptionId)
  if (!sub) throw new BillingError("Subscription not found", 404)

  // Nothing has been paid during a trial, so there is nothing to prorate.
  if (opts.unpaidTrial) {
    return {
      result: { kind: "no_change", unusedCredit: 0, remainingCharge: 0, netAmount: 0 },
      invoice: null,
      credit: null,
    }
  }

  const prorationInput = {
    oldAmount: sub.amount,
    newAmount: round2(num(newAmount)),
    periodStart: sub.current_period_start,
    periodEnd: sub.current_period_end,
    changeDate: today(),
  }
  const result = opts.termChanged ? computeTermChange(prorationInput) : computePlanChange(prorationInput)

  let invoice: InvoiceView | null = null
  let credit: CreditEntry | null = null

  if (result.netAmount > 0) {
    // Upgrade: bill the prorated difference immediately.
    invoice = await createInvoice(
      {
        invoice_type: "one_time",
        subscription_id: subscriptionId,
        customer_name: sub.plan_name,
        currency: sub.currency,
        tax_rate: opts.taxRate ?? 0,
        finalize: true,
        memo: `Prorated upgrade for ${sub.subscription_no}`,
        lines: [
          {
            description: `Prorated plan change (credit ${result.unusedCredit} for unused time, charge ${result.remainingCharge} for new plan)`,
            quantity: 1,
            unit_amount: result.netAmount,
            taxable: true,
            line_type: "proration",
          },
        ],
      },
      session,
    )
  } else if (result.netAmount < 0) {
    // Downgrade: issue the difference back as account credit.
    credit = await createCredit(
      {
        entry_type: "credit",
        reason: `Prorated downgrade credit for ${sub.subscription_no}`,
        amount: Math.abs(result.netAmount),
        currency: sub.currency,
      },
      session,
    )
  }

  return { result, invoice, credit }
}

/**
 * Change a subscription's plan and settle the money.
 * ---------------------------------------------------------------------------
 * Computes the new plan amount for the requested term, applies proration
 * (immediate prorated invoice on upgrade, account credit on downgrade), then
 * persists the plan change on the subscription record. All operations are
 * tenant-scoped through the underlying engines.
 */
export type ChangePlanRequest = { subscription_id: number; plan_id: number; term?: string }

export async function changeSubscriptionPlan(
  input: ChangePlanRequest,
  session: SessionPayload,
  opts: { taxRate?: number } = {},
) {
  await ensureBillingSchema()
  const subscriptionId = num(input.subscription_id)
  const sub = await getSubscriptionView(subscriptionId)
  if (!sub) throw new BillingError("Subscription not found", 404)

  const plan = await getPlan(num(input.plan_id))
  if (!plan) throw new BillingError("Plan not found", 404)

  const term = (input.term && isBillingTerm(input.term) ? input.term : sub.term) as BillingTerm
  if (sub.plan_id === plan.id && sub.term === term) {
    throw new BillingError("This is already your current plan and term.", 409)
  }

  // Validate state (terminal / read-only) BEFORE money moves.
  const current = await loadSubscriptionForChange(subscriptionId)
  if (!canWrite(current.status)) {
    throw new BillingError(
      "Settle the outstanding balance before changing plans (subscription is read-only or suspended).",
      409,
    )
  }

  const newAmount = round2(planPriceForTerm(plan, term))
  const termChanged = term !== sub.term
  const unpaidTrial = current.status === "trial" && !current.last_payment_at
  const proration = await applyPlanChangeProration(subscriptionId, newAmount, session, {
    ...opts,
    termChanged,
    unpaidTrial,
  })
  const periodReset =
    termChanged && !unpaidTrial ? { period_start: today(), period_end: addTerm(today(), term) } : {}
  const changed = await changePlanRecord(subscriptionId, { plan_id: plan.id, term, ...periodReset }, session)

  return { ...changed, proration }
}

/**
 * Tenant-wide payment history across all invoices (newest first).
 * Joins each payment to its invoice number for portal display.
 */
export type PaymentHistoryEntry = Payment & { invoice_no: string | null }

export async function listTenantPayments(limit = 100): Promise<PaymentHistoryEntry[]> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_payments", {
    tail: `ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
  })) as any[]
  const payments = rows.map(mapPayment)
  const invoiceIds = Array.from(new Set(payments.map((p) => p.invoice_id)))
  const numberById = new Map<number, string>()
  if (invoiceIds.length > 0) {
    const placeholders = invoiceIds.map(() => "?").join(", ")
    const invRows = (await tenantSelect("billing_invoices", {
      where: `id IN (${placeholders})`,
      params: invoiceIds,
    })) as any[]
    for (const r of invRows) numberById.set(Number(r.id), String(r.invoice_no))
  }
  return payments.map((p) => ({ ...p, invoice_no: numberById.get(p.invoice_id) ?? null }))
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export async function listReconciliation(): Promise<ReconEntry[]> {
  await ensureBillingSchema()
  const rows = (await tenantSelect("billing_reconciliation", { tail: "ORDER BY created_at DESC" })) as any[]
  return rows.map(mapRecon)
}

export type ReconInput = {
  statement_ref?: string
  gateway?: string
  payout_ref?: string | null
  amount?: number | string
  currency?: string
  payment_reference?: string | null
}

/**
 * Ingest a gateway settlement line and attempt to auto-match it to a payment
 * by reference or by exact outstanding amount. Matched entries flag the
 * payment as reconciled.
 */
export async function ingestReconciliation(input: ReconInput, session: SessionPayload): Promise<ReconEntry> {
  await ensureBillingSchema()
  const amount = round2(num(input.amount))
  const statementRef = String(input.statement_ref ?? "").trim() || `STMT-${Date.now()}`

  // Try to match by explicit payment reference first, then by amount.
  let matchedPayment: Payment | null = null
  if (input.payment_reference) {
    const byRef = (await tenantSelect("billing_payments", {
      where: "(reference = ? OR payment_no = ?) AND status = 'succeeded'",
      params: [input.payment_reference, input.payment_reference],
      tail: "LIMIT 1",
    })) as any[]
    if (byRef[0]) matchedPayment = mapPayment(byRef[0])
  }
  if (!matchedPayment && amount > 0) {
    const byAmount = (await tenantSelect("billing_payments", {
      where: "amount = ? AND status = 'succeeded' AND reconciled = 0",
      params: [amount],
      tail: "ORDER BY created_at ASC LIMIT 1",
    })) as any[]
    if (byAmount[0]) matchedPayment = mapPayment(byAmount[0])
  }

  let invoiceNo: string | null = null
  if (matchedPayment) {
    const inv = await getInvoice(matchedPayment.invoice_id)
    invoiceNo = inv?.invoice_no ?? null
    await tenantUpdate(
      "billing_payments",
      { reconciled: 1, reconciled_at: now() },
      "id = ?",
      [matchedPayment.id],
    )
  }

  const { insertId } = await tenantInsert("billing_reconciliation", {
    statement_ref: statementRef,
    gateway: String(input.gateway ?? "").trim(),
    payout_ref: input.payout_ref || null,
    amount,
    currency: String(input.currency || "USD").trim(),
    payment_id: matchedPayment?.id ?? null,
    invoice_no: invoiceNo,
    status: matchedPayment ? "matched" : "unmatched",
    reconciled_at: matchedPayment ? now() : null,
    created_by: session.userId,
  })
  const created = await requireOwnedRow("billing_reconciliation", insertId)
  return mapRecon(created)
}

// ── Summary ─────────────────────────────────────────────────────────���───────

export async function getBillingSummary(): Promise<BillingSummary> {
  await ensureBillingSchema()
  // MRR is derived from `saas_subscriptions`, owned by the subscription engine.
  // Ensure that schema exists so the summary works before any subscription is
  // created (otherwise a missing table 500s the whole invoices endpoint).
  await ensureSubscriptionSchema()
  const invoices = await listInvoices()
  const [creditBal, coupons, mrrRows] = await Promise.all([
    creditBalance(),
    tenantSelect("billing_coupons", { columns: "id", where: "is_active = 1" }) as Promise<any[]>,
    tenantSelect("saas_subscriptions", {
      columns: "amount, term, status",
      where: "status IN ('active','trial','past_due','grace')",
    }) as Promise<any[]>,
  ])

  const termMonths: Record<string, number> = { monthly: 1, yearly: 12, two_year: 24, five_year: 60 }
  const mrr = round2(
    mrrRows.reduce((s, r) => s + num(r.amount) / (termMonths[String(r.term)] ?? 1), 0),
  )

  const counts = { total: invoices.length, open: 0, paid: 0, draft: 0, void: 0 }
  let outstanding = 0
  let collected = 0
  let refunded = 0
  for (const inv of invoices) {
    if (inv.status === "open" || inv.status === "partially_paid") counts.open++
    else if (inv.status === "paid" || inv.status === "refunded") counts.paid++
    else if (inv.status === "draft") counts.draft++
    else if (inv.status === "void") counts.void++
    if (inv.status !== "void") outstanding += inv.balance
    collected += inv.amount_paid
    refunded += inv.amount_refunded
  }

  return {
    currency: invoices[0]?.currency ?? "USD",
    invoices: counts,
    outstanding: round2(outstanding),
    collected: round2(collected),
    refunded: round2(refunded),
    credit_balance: creditBal,
    coupons_active: coupons.length,
    mrr,
  }
}
