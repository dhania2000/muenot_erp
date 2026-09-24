import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"
import { tdsSummary, tdsDetail, type TdsDirection } from "@/lib/finance-tds-filing"
import { listTdsRules, entityTypeForConstitution } from "@/lib/finance-tds-rules"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { ensureExpensePostingAccounts } from "@/lib/finance-accounts"
import { assertPeriodOpen } from "@/lib/finance-period-lock"
import { getSetting } from "@/lib/settings/server"
import { normalizePan, panStatus } from "@/lib/pan"

export type DeductorIdentity = { tan: string; pan: string; name: string; address: string }

/**
 * The deductor's statutory identity, read from company_settings. This is the
 * single source of truth stamped onto every return and certificate — it is
 * never captured per-transaction.
 */
export async function getDeductorIdentity(): Promise<DeductorIdentity> {
  const [tan, pan, name, company] = await Promise.all([
    getSetting("tds.deductor_tan"),
    getSetting("tds.deductor_pan"),
    getSetting("tds.deductor_name"),
    getSetting("company.name"),
  ])
  return {
    tan: String(tan || "").trim().toUpperCase(),
    pan: normalizePan(pan),
    name: String(name || company || "").trim(),
    address: "",
  }
}

/**
 * TDS downstream compliance engine (server-only).
 *
 * The filing engine (`finance-tds-filing.ts`) turns the source ledgers into a
 * section-wise + deductee-wise view and locks a monthly period. This module
 * carries that forward through the statutory chain that follows deduction:
 *
 *   Liability  → what must be deposited, per month, per direction.
 *   Challan    → the actual government deposit (BSR + challan no.), per month.
 *   Return     → the quarterly statement (24Q salary / 26Q non-salary) that
 *                bundles a quarter's deductions + challans with an ack. token.
 *   Certificate→ Form 16A (quarterly, non-salary deductees) and Form 16
 *                (annual, salaried §192 employees) issued to each deductee.
 *   Reconcile  → the three-way tie-out: deducted (books) vs deposited (challan)
 *                vs reported (return), per quarter.
 *
 * Direction rules:
 *  - "receivable": TDS our customers deduct. WE do not deposit or file it — it
 *    is a credit reconciled against Form 26AS. So challans/returns/certificates
 *    do not apply; only the liability/credit register and a books view do.
 *  - "payable": TDS we deduct on vendor bills/expenses → 26Q.
 *  - "employee": TDS we deduct on FTE salary (§192 → 24Q, Form 16) and
 *    freelance invoices (§194J etc. → 26Q-style, Form 16A).
 *
 * Every schema here is self-creating + idempotent, matching the filing engine.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const FY_RE = /^\d{4}-\d{2}$/

// MySQL has no "ADD COLUMN IF NOT EXISTS", so probe information_schema first.
async function ensureColumn(table: string, column: string, definition: string) {
  const rows = (await query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  ).catch(() => [])) as any[]
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`).catch(() => {})
  }
}

export type TdsQuarter = "Q1" | "Q2" | "Q3" | "Q4"
export type TdsReturnForm = "24Q" | "26Q" | "27Q" | "27EQ"

export const normDirection = (d: any): TdsDirection => {
  const s = String(d)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

/** Whether a direction carries a deposit / return obligation on us. */
export function isDeductorDirection(direction: TdsDirection) {
  return direction === "payable" || direction === "employee"
}

/**
 * Sections whose payee is a non-resident → reported on Form 27Q instead of 26Q.
 * A deductee lands here purely by the statutory section entered on its source
 * document (e.g. §195 payment to a non-resident contractor), so no separate
 * "resident/non-resident" flag is needed to route the return.
 */
const NON_RESIDENT_SECTIONS = new Set([
  "195", "194E", "194LB", "194LBA", "194LBB", "194LBC", "194LC", "194LD", "196A", "196B", "196C", "196D",
])

/** Normalise a section token for classification ("194 J" → "194J"). */
function normSection(section: unknown): string {
  return String(section || "").toUpperCase().replace(/\s+/g, "")
}

/**
 * Map a statutory section to the return form it belongs on:
 *  - §192 salary (employee direction) → 24Q
 *  - 206C* collection-at-source       → 27EQ (TCS, kept out of TDS returns)
 *  - non-resident sections            → 27Q
 *  - everything else                  → 26Q
 */
export function formForSection(section: string, direction: TdsDirection): TdsReturnForm {
  const s = normSection(section)
  if (direction === "employee" && s === "192") return "24Q"
  if (s.startsWith("206C")) return "27EQ"
  if (NON_RESIDENT_SECTIONS.has(s)) return "27Q"
  return direction === "employee" ? "24Q" : "26Q"
}

/** The statutory return forms a deductor direction can file. */
export function applicableForms(direction: TdsDirection): TdsReturnForm[] {
  return direction === "employee" ? ["24Q", "27Q"] : ["26Q", "27Q", "27EQ"]
}

/** The default (primary) return form for a deductor direction. */
export function returnFormFor(direction: TdsDirection): TdsReturnForm {
  return direction === "employee" ? "24Q" : "26Q"
}

/**
 * Whether a detail row's section belongs on the requested return form. The
 * "primary" form for a direction (24Q / 26Q) sweeps up everything that is not
 * carved out to a non-resident (27Q) or TCS (27EQ) form, so no deduction is
 * ever silently dropped from filing.
 */
function rowMatchesForm(section: string, direction: TdsDirection, formType: TdsReturnForm): boolean {
  const f = formForSection(section, direction)
  if (formType === "27Q" || formType === "27EQ") return f === formType
  return f !== "27Q" && f !== "27EQ"
}

/** Financial year label ("2024-25") for a YYYY-MM period. */
export function fyOfPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number)
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** The 12 months (Apr→Mar) of a financial year, as YYYY-MM. */
export function monthsOfFy(financialYear: string): string[] {
  if (!FY_RE.test(financialYear)) throw new Error("Financial year must be in YYYY-YY format, e.g. 2024-25.")
  const startYear = Number(financialYear.split("-")[0])
  const out: string[] = []
  for (let i = 0; i < 12; i++) {
    const monthIndex = 3 + i // 0-based, April = 3
    const year = startYear + Math.floor(monthIndex / 12)
    const month = (monthIndex % 12) + 1
    out.push(`${year}-${String(month).padStart(2, "0")}`)
  }
  return out
}

/** Which quarter a YYYY-MM period falls in (Indian TDS: Q1 = Apr–Jun). */
export function quarterOfPeriod(period: string): TdsQuarter {
  const m = Number(period.split("-")[1])
  if (m >= 4 && m <= 6) return "Q1"
  if (m >= 7 && m <= 9) return "Q2"
  if (m >= 10 && m <= 12) return "Q3"
  return "Q4"
}

/** The 3 months of a quarter within a financial year, as YYYY-MM. */
export function monthsOfQuarter(quarter: TdsQuarter, financialYear: string): string[] {
  const all = monthsOfFy(financialYear)
  const map: Record<TdsQuarter, number> = { Q1: 0, Q2: 3, Q3: 6, Q4: 9 }
  const start = map[quarter]
  return all.slice(start, start + 3)
}

/** Deposit due date for a month's TDS: 7th of next month; March → 30 April. */
export function depositDueDate(period: string): string {
  const [y, m] = period.split("-").map(Number)
  if (m === 3) return `${y}-04-30`
  const nextMonth = m === 12 ? 1 : m + 1
  const nextYear = m === 12 ? y + 1 : y
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-07`
}

/** Return filing due date per quarter. Q1 31Jul, Q2 31Oct, Q3 31Jan, Q4 31May. */
export function returnDueDate(quarter: TdsQuarter, financialYear: string): string {
  const startYear = Number(financialYear.split("-")[0])
  switch (quarter) {
    case "Q1":
      return `${startYear}-07-31`
    case "Q2":
      return `${startYear}-10-31`
    case "Q3":
      return `${startYear + 1}-01-31`
    default:
      return `${startYear + 1}-05-31`
  }
}

// ---------------------------------------------------------------------------
// Phase 47–48 — statutory interest & late-fee auto-calculation.
//
// These are pure, deterministic SUGGESTIONS derived from the deducted amount +
// the statutory due dates already defined above. They never touch a ledger; the
// challan / return flow may accept, override, or ignore them. Interest and late
// fee are always kept SEPARATE from the TDS principal.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000

/** Whole months between two dates counting any part-month as a full month (min 1). */
function partMonthsBetween(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
  if (to.getDate() >= from.getDate()) months += 1 // any part of a further month counts as one
  return Math.max(1, months)
}

export type DepositChargeSuggestion = {
  period: string
  tds_amount: number
  due_date: string
  payment_date: string
  overdue: boolean
  months_delayed: number
  interest_rate_pct: number
  interest: number
  basis: string
}

/**
 * §201(1A) interest on late DEPOSIT of TDS: 1.5% per month (or part of a month)
 * from the month of deduction to the month of deposit. We treat the deduction
 * date as the first day of the deduction month and only charge interest once the
 * statutory deposit due date has passed.
 */
export function suggestDepositInterest(
  period: string,
  tdsAmount: number,
  paymentDate?: string | null,
): DepositChargeSuggestion {
  const tds = round2(tdsAmount)
  const due = depositDueDate(period)
  const payStr = (paymentDate || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const pay = new Date(payStr)
  const dueDate = new Date(due)
  const [y, m] = period.split("-").map(Number)
  const deductionRef = new Date(y, (m || 1) - 1, 1)
  const overdue = pay.getTime() > dueDate.getTime() && tds > 0
  const months = overdue ? partMonthsBetween(deductionRef, pay) : 0
  const rate = 1.5
  const interest = overdue ? round2(tds * (rate / 100) * months) : 0
  return {
    period,
    tds_amount: tds,
    due_date: due,
    payment_date: payStr,
    overdue,
    months_delayed: months,
    interest_rate_pct: rate,
    interest,
    basis: overdue
      ? `§201(1A): ${rate}% × ${months} month(s) on ${tds} (deducted ${period}, deposited ${payStr}, due ${due})`
      : `On time — deposited by due date ${due}, no interest.`,
  }
}

export type ReturnLateFeeSuggestion = {
  quarter: TdsQuarter
  financial_year: string
  tds_amount: number
  due_date: string
  filing_date: string
  overdue: boolean
  days_delayed: number
  fee_per_day: number
  late_fee: number
  basis: string
}

/**
 * §234E late-filing fee for a TDS return: ₹200 per day of delay past the return
 * due date, capped at the total TDS of the statement.
 */
export function suggestReturnLateFee(
  quarter: TdsQuarter,
  financialYear: string,
  tdsAmount: number,
  filingDate?: string | null,
): ReturnLateFeeSuggestion {
  const tds = round2(tdsAmount)
  const due = returnDueDate(quarter, financialYear)
  const fileStr = (filingDate || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const dueDate = new Date(due)
  const filed = new Date(fileStr)
  const overdue = filed.getTime() > dueDate.getTime() && tds > 0
  const days = overdue ? Math.max(1, Math.round((filed.getTime() - dueDate.getTime()) / MS_PER_DAY)) : 0
  const perDay = 200
  const late = overdue ? round2(Math.min(tds, days * perDay)) : 0
  return {
    quarter,
    financial_year: financialYear,
    tds_amount: tds,
    due_date: due,
    filing_date: fileStr,
    overdue,
    days_delayed: days,
    fee_per_day: perDay,
    late_fee: late,
    basis: overdue
      ? `§234E: ₹${perDay}/day × ${days} day(s) = ${round2(days * perDay)}, capped at TDS ${tds}`
      : `On time — filed by due date ${due}, no late fee.`,
  }
}

let ensured = false

export async function ensureTdsComplianceSchema() {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS tds_challans (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      challan_id VARCHAR(40) NOT NULL,
      direction VARCHAR(12) NOT NULL DEFAULT 'payable',
      period VARCHAR(7) NOT NULL,                 -- YYYY-MM deducted
      quarter VARCHAR(4) NOT NULL,
      financial_year VARCHAR(12) DEFAULT NULL,
      bsr_code VARCHAR(20) DEFAULT NULL,
      challan_no VARCHAR(40) DEFAULT NULL,
      payment_date DATE DEFAULT NULL,
      tds_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      interest DECIMAL(16,2) NOT NULL DEFAULT 0,
      late_fee DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      payment_mode VARCHAR(30) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Deposited',
      note VARCHAR(255) DEFAULT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tds_challan_id (challan_id),
      KEY idx_tds_challan_period (period, direction),
      KEY idx_tds_challan_fy (financial_year, direction)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS tds_returns (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      return_id VARCHAR(40) NOT NULL,
      form_type VARCHAR(8) NOT NULL,              -- 24Q / 26Q
      direction VARCHAR(12) NOT NULL,
      quarter VARCHAR(4) NOT NULL,
      financial_year VARCHAR(12) NOT NULL,
      total_base DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_deducted DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_deposited DECIMAL(16,2) NOT NULL DEFAULT 0,
      deductee_count INT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Filed',
      token_no VARCHAR(40) DEFAULT NULL,
      snapshot LONGTEXT DEFAULT NULL,
      filed_at TIMESTAMP NULL DEFAULT NULL,
      filed_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tds_return_id (return_id),
      UNIQUE KEY uq_tds_return_period (form_type, quarter, financial_year)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS tds_certificates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      certificate_id VARCHAR(40) NOT NULL,
      form_type VARCHAR(8) NOT NULL,              -- 16 / 16A
      direction VARCHAR(12) NOT NULL,
      return_id VARCHAR(40) DEFAULT NULL,
      quarter VARCHAR(4) DEFAULT NULL,            -- NULL for annual Form 16
      financial_year VARCHAR(12) NOT NULL,
      party_id VARCHAR(60) DEFAULT NULL,
      party_name VARCHAR(190) DEFAULT NULL,
      pan VARCHAR(20) DEFAULT NULL,
      sections VARCHAR(190) DEFAULT NULL,
      total_base DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_tds DECIMAL(16,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Issued',
      snapshot LONGTEXT DEFAULT NULL,
      issued_at TIMESTAMP NULL DEFAULT NULL,
      issued_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tds_certificate_id (certificate_id),
      UNIQUE KEY uq_tds_cert_party (form_type, financial_year, quarter, party_id),
      KEY idx_tds_cert_fy (financial_year, direction)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Phase 19–20 — challan → Bank/Journal/GL linkage. A deposited challan posts a
  // real balanced voucher (Dr TDS Payable / Cr Bank·Cash), exactly like the GST
  // cash-ledger payment. These columns key that posting so it can be shown on
  // the register and reversed when the challan is deleted. Added in place on
  // older DBs that created tds_challans before this phase.
  await ensureColumn("tds_challans", "voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("tds_challans", "posted_amount", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn("tds_challans", "posted_mode", "VARCHAR(10) DEFAULT NULL")
  await ensureColumn("tds_challans", "posting_status", "VARCHAR(20) NOT NULL DEFAULT 'Unposted'")

  // Phase 16 — the physical deposit reference: which bank the challan was paid
  // through and its transaction/UTR reference. These are statutory challan
  // attributes (shown on the return) that older DBs never captured.
  await ensureColumn("tds_challans", "bank_name", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn("tds_challans", "payment_ref", "VARCHAR(80) DEFAULT NULL")

  // Phase 17 — challan allocation. A single challan settles many deductee lines;
  // NSDL returns require each challan to be mapped to the deductee rows it
  // covers. We persist that mapping so a challan's deposit can be split across
  // deductees + sections, which in turn lets a 26Q / 27Q / 27EQ return read back
  // exactly how much of each challan belongs to it.
  await query(
    `CREATE TABLE IF NOT EXISTS tds_challan_allocations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      challan_id VARCHAR(40) NOT NULL,
      direction VARCHAR(12) NOT NULL,
      period VARCHAR(7) NOT NULL,
      party_id VARCHAR(60) DEFAULT NULL,
      party_name VARCHAR(190) DEFAULT NULL,
      section VARCHAR(20) DEFAULT NULL,
      form_type VARCHAR(8) DEFAULT NULL,
      amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_alloc_challan (challan_id),
      KEY idx_alloc_period (period, direction),
      KEY idx_alloc_form (form_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Phase 38-40 — return lifecycle, acknowledgement and correction chain. The
  // original strict (form,quarter,fy) uniqueness is dropped so a quarter can be
  // filed once as an original and then re-filed any number of times as
  // corrections; a second *active original* is instead blocked in application
  // code (fileTdsReturn) so history is never overwritten.
  const strictReturnIdx = (await query(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'tds_returns' AND index_name = 'uq_tds_return_period' LIMIT 1`,
  ).catch(() => [])) as any[]
  if (strictReturnIdx.length > 0) {
    await query(`ALTER TABLE tds_returns DROP INDEX uq_tds_return_period`).catch(() => {})
  }
  await ensureColumn("tds_returns", "arn", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn("tds_returns", "original_return_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("tds_returns", "correction_type", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("tds_returns", "revision_no", "INT NOT NULL DEFAULT 0")
  await ensureColumn("tds_returns", "is_correction", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn("tds_returns", "remarks", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("tds_returns", "challan_label", "VARCHAR(190) DEFAULT NULL")

  // Phase 35 — certificate status lifecycle + correction linkage. The row itself
  // moves Generated → Issued → Corrected in place (a correction recomputes the
  // same certificate from the current ledger rather than creating a duplicate,
  // which the (form,fy,quarter,party) unique key would reject anyway).
  await ensureColumn("tds_certificates", "corrected_from", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("tds_certificates", "remarks", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("tds_certificates", "corrected_at", "TIMESTAMP NULL DEFAULT NULL")

  // Phase 31-32 — automated compliance calendar + reminder ledger. The calendar
  // itself is derived on the fly from the deductee ledger + statutory due dates
  // (nothing to persist). What we DO persist is the reminder each due date has
  // spawned, so a due date is only ever alerted once per channel and the sweep
  // is idempotent — the cron can run hourly without creating duplicates.
  await query(
    `CREATE TABLE IF NOT EXISTS tds_reminders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      reminder_id VARCHAR(40) NOT NULL,
      obligation_key VARCHAR(120) NOT NULL,       -- stable id of the calendar item
      kind VARCHAR(24) NOT NULL,                  -- challan / return / certificate
      direction VARCHAR(12) NOT NULL,
      form_type VARCHAR(8) DEFAULT NULL,
      quarter VARCHAR(4) DEFAULT NULL,
      period VARCHAR(7) DEFAULT NULL,
      financial_year VARCHAR(12) DEFAULT NULL,
      due_date DATE NOT NULL,
      title VARCHAR(190) NOT NULL,
      amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      severity VARCHAR(16) NOT NULL DEFAULT 'upcoming',
      status VARCHAR(16) NOT NULL DEFAULT 'open',  -- open / acknowledged / done / dismissed
      offset_label VARCHAR(24) DEFAULT NULL,       -- which lead time fired (e.g. T-7, DUE, OVERDUE)
      note VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tds_reminder_fire (obligation_key, offset_label),
      KEY idx_tds_reminder_due (due_date),
      KEY idx_tds_reminder_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  ensured = true
}

// ---------------------------------------------------------------------------
// Return status lifecycle (Phase 38)
// ---------------------------------------------------------------------------

/**
 * The statutory return workflow. "Filed" and "Nil"/"Not filed" (computed) are
 * preserved from the original engine; the rest are the richer states a preparer
 * moves a return through. Draft/Ready are pre-submission; the remainder are
 * post-submission handling states.
 */
export const TDS_RETURN_STATUSES = [
  "Draft",
  "Ready",
  "Under Review",
  "Filed",
  "Payment Pending",
  "Correction Required",
  "Rejected",
  "Cancelled",
] as const
export type TdsReturnStatus = (typeof TDS_RETURN_STATUSES)[number]

/** Allowed forward/lateral transitions for a return status (Phase 38). */
const RETURN_TRANSITIONS: Record<string, TdsReturnStatus[]> = {
  Draft: ["Ready", "Cancelled"],
  Ready: ["Under Review", "Filed", "Draft", "Cancelled"],
  "Under Review": ["Filed", "Correction Required", "Ready", "Cancelled"],
  Filed: ["Payment Pending", "Correction Required", "Rejected"],
  "Payment Pending": ["Filed", "Correction Required"],
  "Correction Required": ["Filed", "Cancelled"],
  Rejected: ["Ready", "Cancelled"],
  Cancelled: [],
}

export function allowedReturnTransitions(status: string): TdsReturnStatus[] {
  return RETURN_TRANSITIONS[status] ?? []
}

// ---------------------------------------------------------------------------
// Challan → Journal/GL posting bridge (Phase 19–20).
//
// Depositing a challan settles the TDS Payable liability that the purchase-bill
// / expense / invoice postings accrued (Cr TDS Payable, code 2150) and moves
// cash out of the bank. Interest and late fee are period costs. The double
// entry, posted through the SAME engine every other document uses:
//
//   Dr TDS Payable        tds_amount
//   Dr General Expenses   interest + late_fee     (only when > 0)
//      Cr Bank / Cash     total_amount
//
// Receivable TDS never reaches here — challans only exist for deductor
// directions (guarded in createChallan).
// ---------------------------------------------------------------------------

function challanMode(paymentMode: string | null | undefined): "bank" | "cash" {
  return String(paymentMode || "").toLowerCase().includes("cash") ? "cash" : "bank"
}

function challanDepositLines(tds: number, interest: number, lateFee: number, mode: "bank" | "cash"): PostingLine[] {
  const t = round2(tds)
  const cost = round2(num(interest) + num(lateFee))
  const total = round2(t + cost)
  const lines: PostingLine[] = []
  if (t > 0) lines.push({ role: "tds_payable", debit: t, credit: 0, tds: t })
  if (cost > 0) lines.push({ role: "expense", debit: cost, credit: 0 })
  lines.push({ role: mode === "cash" ? "cash" : "bank", debit: 0, credit: total })
  return lines
}

function challanPostArgs(
  fields: { challanId: string; period: string; financialYear: string | null; paymentDate: string | null },
  narration: string,
) {
  return {
    entityType: "tds_challan",
    entityId: 0,
    entityRef: fields.challanId,
    date: fields.paymentDate ? String(fields.paymentDate).slice(0, 10) : new Date().toISOString().slice(0, 10),
    financialYear: fields.financialYear ?? fyOfPeriod(fields.period),
    voucherType: "Payment",
    narration,
    sourceModule: "TDS Filing",
  }
}

// ---------------------------------------------------------------------------
// Challans
// ---------------------------------------------------------------------------

export type TdsChallan = {
  id: number
  challan_id: string
  direction: string
  period: string
  quarter: string
  financial_year: string | null
  bsr_code: string | null
  challan_no: string | null
  payment_date: string | null
  tds_amount: number
  interest: number
  late_fee: number
  total_amount: number
  payment_mode: string | null
  bank_name: string | null
  payment_ref: string | null
  status: string
  note: string | null
}

function mapChallan(r: any): TdsChallan {
  return {
    id: Number(r.id),
    challan_id: r.challan_id,
    direction: r.direction,
    period: r.period,
    quarter: r.quarter,
    financial_year: r.financial_year ?? null,
    bsr_code: r.bsr_code ?? null,
    challan_no: r.challan_no ?? null,
    payment_date: r.payment_date ? String(r.payment_date).slice(0, 10) : null,
    tds_amount: round2(num(r.tds_amount)),
    interest: round2(num(r.interest)),
    late_fee: round2(num(r.late_fee)),
    total_amount: round2(num(r.total_amount)),
    payment_mode: r.payment_mode ?? null,
    bank_name: r.bank_name ?? null,
    payment_ref: r.payment_ref ?? null,
    status: r.status,
    note: r.note ?? null,
  }
}

export async function listChallans(direction: TdsDirection, financialYear?: string): Promise<TdsChallan[]> {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  const rows = (await query(
    `SELECT * FROM tds_challans
       WHERE direction = ? ${financialYear ? "AND financial_year = ?" : ""}
       ORDER BY period DESC, id DESC LIMIT 300`,
    financialYear ? [dir, financialYear] : [dir],
  ).catch(() => [])) as any[]
  return rows.map(mapChallan)
}

export async function createChallan(input: {
  direction: TdsDirection
  period: string
  bsrCode?: string | null
  challanNo?: string | null
  paymentDate?: string | null
  tdsAmount: number
  interest?: number
  lateFee?: number
  paymentMode?: string | null
  bankName?: string | null
  paymentRef?: string | null
  note?: string | null
  actorId?: number | null
}): Promise<{ challan_id: string; voucher_no: string | null }> {
  await ensureTdsComplianceSchema()
  const dir = normDirection(input.direction)
  if (!isDeductorDirection(dir)) throw new Error("Challans only apply to TDS you deposit (payable / employee).")
  if (!PERIOD_RE.test(input.period)) throw new Error("Period must be in YYYY-MM format.")
  const tds = round2(input.tdsAmount)
  if (!(tds > 0)) throw new Error("Challan TDS amount must be greater than zero.")

  const interest = round2(input.interest ?? 0)
  const lateFee = round2(input.lateFee ?? 0)
  const total = round2(tds + interest + lateFee)
  const quarter = quarterOfPeriod(input.period)
  const fy = fyOfPeriod(input.period)

  // SPEC 162 — a TDS challan cannot be deposited/posted into a locked period.
  // Guard by the posting date (payment date if given, else the challan period).
  await assertPeriodOpen(input.paymentDate || input.period)

  const challanId = await nextRecordId("TCH")

  await query(
    `INSERT INTO tds_challans
       (challan_id, direction, period, quarter, financial_year, bsr_code, challan_no, payment_date,
        tds_amount, interest, late_fee, total_amount, payment_mode, bank_name, payment_ref, status, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      challanId, dir, input.period, quarter, fy, input.bsrCode || null, input.challanNo || null,
      input.paymentDate || null, tds, interest, lateFee, total, input.paymentMode || null,
      input.bankName || null, input.paymentRef || null, "Deposited", input.note || null, input.actorId ?? null,
    ],
  )

  // Auto-post the deposit to Bank → Journal → GL (Phase 19–20). A posting
  // failure never blocks the challan record — it is left Unposted for retry.
  let voucherNo: string | null = null
  const mode = challanMode(input.paymentMode)
  try {
    await ensureExpensePostingAccounts()
    const result = await postLines(
      challanDepositLines(tds, interest, lateFee, mode),
      {
        ...challanPostArgs(
          { challanId, period: input.period, financialYear: fy, paymentDate: input.paymentDate ?? null },
          `TDS challan ${challanId} deposit for ${input.period} (${mode === "cash" ? "Cash" : "Bank"})`,
        ),
        createdBy: input.actorId ?? null,
      },
    )
    voucherNo = result.voucherNo
    await query(
      `UPDATE tds_challans SET voucher_no = ?, posted_amount = ?, posted_mode = ?, posting_status = 'Posted' WHERE challan_id = ?`,
      [voucherNo, total, mode, challanId],
    )
  } catch (error) {
    console.log("[v0] tds challan posting failed for", challanId, (error as Error)?.message)
    await query(`UPDATE tds_challans SET posting_status = 'Unposted' WHERE challan_id = ?`, [challanId]).catch(() => {})
  }

  await logFinanceEvent({
    entityType: "tds_challan",
    entityRef: challanId,
    type: "payment_recorded",
    summary: `TDS challan ${challanId} (${dir}) for ${input.period}: ${total}${voucherNo ? ` → ${voucherNo}` : ""}`,
    amount: total,
    actorId: input.actorId ?? null,
  })
  return { challan_id: challanId, voucher_no: voucherNo }
}

export async function deleteChallan(challanId: string, actorId?: number | null) {
  await ensureTdsComplianceSchema()
  const [row] = (await query(`SELECT * FROM tds_challans WHERE challan_id = ? LIMIT 1`, [challanId])) as any[]
  if (!row) throw new Error("Challan not found.")

  // SPEC 162 — a challan whose posting date falls in a locked period cannot be deleted/reversed.
  await assertPeriodOpen(row.payment_date ? String(row.payment_date).slice(0, 10) : row.period)

  // Unwind the Bank/Journal/GL posting before deleting the challan (Phase 19–20).
  if (row.voucher_no) {
    try {
      const mode = String(row.posted_mode || "") === "cash" ? "cash" : challanMode(row.payment_mode)
      await postLines(
        challanDepositLines(num(row.tds_amount), num(row.interest), num(row.late_fee), mode),
        {
          ...challanPostArgs(
            {
              challanId,
              period: row.period,
              financialYear: row.financial_year ?? null,
              paymentDate: row.payment_date ?? null,
            },
            `Reversal of TDS challan ${challanId}`,
          ),
          reverse: true,
          createdBy: actorId ?? null,
        },
      )
    } catch (error) {
      console.log("[v0] tds challan reversal failed for", challanId, (error as Error)?.message)
    }
  }

  await query(`DELETE FROM tds_challans WHERE challan_id = ?`, [challanId])
  await logFinanceEvent({
    entityType: "tds_challan",
    entityRef: challanId,
    type: "deleted",
    summary: `TDS challan ${challanId} deleted`,
    amount: num(row.total_amount),
    actorId: actorId ?? null,
  })
  return { ok: true }
}

async function depositByPeriod(direction: TdsDirection, financialYear: string) {
  const challans = await listChallans(direction, financialYear)
  const map: Record<string, number> = {}
  for (const c of challans) map[c.period] = round2((map[c.period] || 0) + c.tds_amount)
  return map
}

/** Per-period challan charges: TDS deposited, interest, late fee and total paid. */
async function challanChargesByPeriod(direction: TdsDirection, financialYear: string) {
  const challans = await listChallans(direction, financialYear)
  const map: Record<string, { tds: number; interest: number; late_fee: number; total: number }> = {}
  for (const c of challans) {
    const e = map[c.period] || { tds: 0, interest: 0, late_fee: 0, total: 0 }
    e.tds = round2(e.tds + c.tds_amount)
    e.interest = round2(e.interest + c.interest)
    e.late_fee = round2(e.late_fee + c.late_fee)
    e.total = round2(e.total + c.total_amount)
    map[c.period] = e
  }
  return map
}

// ---------------------------------------------------------------------------
// Phase 17 — challan allocation
//
// A single challan settles many deductee lines. NSDL returns (26Q/24Q/27Q)
// require every deductee row to point at the challan that deposited its tax.
// We map a challan onto the deductee/section rows of its own tax period, so a
// challan can never be over-allocated and the return reads back exactly how
// much of each challan belongs to it.
// ---------------------------------------------------------------------------

export type TdsAllocation = {
  id: number
  challan_id: string
  period: string
  party_id: string | null
  party_name: string | null
  section: string | null
  amount: number
}

function mapAllocation(r: any): TdsAllocation {
  return {
    id: Number(r.id),
    challan_id: r.challan_id,
    period: r.period,
    party_id: r.party_id ?? null,
    party_name: r.party_name ?? null,
    section: r.section ?? null,
    amount: round2(num(r.amount)),
  }
}

export async function listChallanAllocations(challanId: string): Promise<TdsAllocation[]> {
  await ensureTdsComplianceSchema()
  const rows = (await query(
    `SELECT * FROM tds_challan_allocations WHERE challan_id = ? ORDER BY id ASC`,
    [challanId],
  ).catch(() => [])) as any[]
  return rows.map(mapAllocation)
}

/**
 * The unallocated headroom of a challan: its TDS amount minus everything it has
 * already been mapped to.
 */
export async function challanAllocatable(challanId: string): Promise<{
  challan_id: string
  tds_amount: number
  allocated: number
  unallocated: number
}> {
  await ensureTdsComplianceSchema()
  const [c] = (await query(`SELECT * FROM tds_challans WHERE challan_id = ? LIMIT 1`, [challanId])) as any[]
  if (!c) throw new Error("Challan not found.")
  const [{ total = 0 } = {}] = (await query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM tds_challan_allocations WHERE challan_id = ?`,
    [challanId],
  ).catch(() => [{ total: 0 }])) as any[]
  const tds = round2(num(c.tds_amount))
  const allocated = round2(num(total))
  return { challan_id: challanId, tds_amount: tds, allocated, unallocated: round2(tds - allocated) }
}

/**
 * The open deductee/section rows for a challan's tax period, each carrying how
 * much of that row is still unmatched by any challan. This drives the
 * allocation UI and the auto-allocate pass.
 */
export async function allocationCandidates(challanId: string) {
  await ensureTdsComplianceSchema()
  const [c] = (await query(`SELECT * FROM tds_challans WHERE challan_id = ? LIMIT 1`, [challanId])) as any[]
  if (!c) throw new Error("Challan not found.")
  const dir = normDirection(c.direction) as TdsDirection
  const detail = await tdsDetail(c.period, dir)

  const byRow = new Map<string, { party_id: string; party_name: string; section: string; tds: number }>()
  for (const r of detail) {
    const key = `${r.party_id || r.party_name || "—"}::${r.section}`
    const prev = byRow.get(key)
    if (prev) prev.tds = round2(prev.tds + num(r.tds))
    else
      byRow.set(key, {
        party_id: String(r.party_id || ""),
        party_name: r.party_name || "—",
        section: String(r.section),
        tds: round2(num(r.tds)),
      })
  }

  // How much of each row is already covered by ANY challan of this period.
  const existing = (await query(
    `SELECT party_id, party_name, section, COALESCE(SUM(amount),0) AS allocated
       FROM tds_challan_allocations WHERE direction = ? AND period = ?
       GROUP BY party_id, party_name, section`,
    [dir, c.period],
  ).catch(() => [])) as any[]
  const coveredBy = new Map<string, number>()
  for (const e of existing) {
    const key = `${e.party_id || e.party_name || "—"}::${e.section}`
    coveredBy.set(key, round2(num(e.allocated)))
  }

  return Array.from(byRow.entries()).map(([key, row]) => {
    const covered = coveredBy.get(key) || 0
    return { ...row, covered: round2(covered), open: round2(Math.max(0, row.tds - covered)) }
  })
}

export async function allocateChallan(input: {
  challanId: string
  lines: { party_id?: string | null; party_name?: string | null; section?: string | null; amount: number }[]
  actorId?: number | null
}) {
  await ensureTdsComplianceSchema()
  const [c] = (await query(`SELECT * FROM tds_challans WHERE challan_id = ? LIMIT 1`, [input.challanId])) as any[]
  if (!c) throw new Error("Challan not found.")
  const dir = normDirection(c.direction)
  const formType = returnFormFor(dir as TdsDirection)

  const lines = input.lines.map((l) => ({ ...l, amount: round2(l.amount) })).filter((l) => l.amount > 0)
  if (lines.length === 0) throw new Error("Nothing to allocate.")

  const requested = round2(lines.reduce((s, l) => s + l.amount, 0))
  const head = await challanAllocatable(input.challanId)
  if (requested > head.unallocated + 0.01) {
    throw new Error(
      `Allocation ${requested.toFixed(2)} exceeds the challan's unallocated balance ${head.unallocated.toFixed(2)}.`,
    )
  }

  for (const l of lines) {
    await query(
      `INSERT INTO tds_challan_allocations
         (challan_id, direction, period, party_id, party_name, section, form_type, amount)
       VALUES (?,?,?,?,?,?,?,?)`,
      [input.challanId, dir, c.period, l.party_id || null, l.party_name || null, l.section || null, formType, l.amount],
    )
  }

  await logFinanceEvent({
    entityType: "tds_challan",
    entityRef: input.challanId,
    type: "allocated",
    summary: `Allocated ${requested.toFixed(2)} of challan ${input.challanId} across ${lines.length} deductee line(s)`,
    amount: requested,
    actorId: input.actorId ?? null,
  })
  return { ok: true, allocated: requested }
}

/**
 * Greedily map a challan's unallocated balance onto its period's open deductee
 * rows, largest first. Lets a user allocate a full challan in one click.
 */
export async function autoAllocateChallan(challanId: string, actorId?: number | null) {
  const head = await challanAllocatable(challanId)
  if (head.unallocated <= 0) return { ok: true, allocated: 0 }
  const candidates = (await allocationCandidates(challanId))
    .filter((r) => r.open > 0)
    .sort((a, b) => b.open - a.open)

  let remaining = head.unallocated
  const lines: { party_id: string; party_name: string; section: string; amount: number }[] = []
  for (const r of candidates) {
    if (remaining <= 0) break
    const take = round2(Math.min(remaining, r.open))
    if (take <= 0) continue
    lines.push({ party_id: r.party_id, party_name: r.party_name, section: r.section, amount: take })
    remaining = round2(remaining - take)
  }
  if (lines.length === 0) return { ok: true, allocated: 0 }
  return allocateChallan({ challanId, lines, actorId })
}

export async function clearChallanAllocations(challanId: string, actorId?: number | null) {
  await ensureTdsComplianceSchema()
  await query(`DELETE FROM tds_challan_allocations WHERE challan_id = ?`, [challanId])
  await logFinanceEvent({
    entityType: "tds_challan",
    entityRef: challanId,
    type: "allocation_cleared",
    summary: `Cleared challan ${challanId} allocations`,
    actorId: actorId ?? null,
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Liability register
// ---------------------------------------------------------------------------

export type TdsLiabilityRow = {
  period: string
  quarter: TdsQuarter
  base: number
  deducted: number
  interest: number
  late_fee: number
  total_liability: number
  deposited: number
  paid: number
  balance: number
  due_date: string
  status: string
}

export type TdsQuarterSummaryRow = {
  quarter: TdsQuarter
  base: number
  tds: number
  payments: number
  balance: number
  return_form: TdsReturnForm | null
  return_id: string | null
  return_status: string
  return_due_date: string
}

function liabilityStatus(direction: TdsDirection, deducted: number, deposited: number): string {
  if (deducted <= 0) return "Nil"
  if (!isDeductorDirection(direction)) return "Credit"
  if (deposited >= deducted) return "Deposited"
  if (deposited > 0) return "Partial"
  return "Pending"
}

export async function tdsLiability(financialYear: string, direction: TdsDirection) {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  const deductor = isDeductorDirection(dir)
  const months = monthsOfFy(financialYear)
  const charges = deductor ? await challanChargesByPeriod(dir, financialYear) : {}

  const rows: TdsLiabilityRow[] = []
  for (const period of months) {
    const summary = await tdsSummary(period, dir)
    const base = round2(summary.totals.total_base)
    const deducted = round2(summary.totals.total_tds)
    const c = charges[period] || { tds: 0, interest: 0, late_fee: 0, total: 0 }
    const interest = round2(c.interest)
    const lateFee = round2(c.late_fee)
    const deposited = round2(c.tds)
    // Total liability = tax deducted + statutory interest (234E/201) + late fee.
    const totalLiability = round2(deducted + interest + lateFee)
    const paid = round2(c.total)
    rows.push({
      period,
      quarter: quarterOfPeriod(period),
      base,
      deducted,
      interest,
      late_fee: lateFee,
      total_liability: totalLiability,
      deposited,
      paid,
      balance: round2(totalLiability - paid),
      due_date: depositDueDate(period),
      status: liabilityStatus(dir, deducted, deposited),
    })
  }

  const totals = {
    base: round2(rows.reduce((s, r) => s + r.base, 0)),
    deducted: round2(rows.reduce((s, r) => s + r.deducted, 0)),
    interest: round2(rows.reduce((s, r) => s + r.interest, 0)),
    late_fee: round2(rows.reduce((s, r) => s + r.late_fee, 0)),
    total_liability: round2(rows.reduce((s, r) => s + r.total_liability, 0)),
    deposited: round2(rows.reduce((s, r) => s + r.deposited, 0)),
    paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
    balance: round2(rows.reduce((s, r) => s + r.balance, 0)),
  }

  // Phase 27 — quarterly rollup with each quarter's statutory return status.
  const returns = deductor ? await listTdsReturns(dir) : []
  const quarters: TdsQuarter[] = ["Q1", "Q2", "Q3", "Q4"]
  const quarterly: TdsQuarterSummaryRow[] = quarters.map((q) => {
    const qRows = rows.filter((r) => r.quarter === q)
    const base = round2(qRows.reduce((s, r) => s + r.base, 0))
    const tds = round2(qRows.reduce((s, r) => s + r.deducted, 0))
    const payments = round2(qRows.reduce((s, r) => s + r.paid, 0))
    const totalLiability = round2(qRows.reduce((s, r) => s + r.total_liability, 0))
    const ret = returns.find((r) => r.quarter === q && r.financial_year === financialYear)
    return {
      quarter: q,
      base,
      tds,
      payments,
      balance: round2(totalLiability - payments),
      return_form: deductor ? returnFormFor(dir) : null,
      return_id: ret?.return_id ?? null,
      return_status: ret ? ret.status : deductor ? (tds > 0 ? "Not filed" : "Nil") : "Credit",
      return_due_date: returnDueDate(q, financialYear),
    }
  })

  return {
    financial_year: financialYear,
    direction: dir,
    deposit_applicable: deductor,
    rows,
    totals,
    quarterly,
  }
}

// ---------------------------------------------------------------------------
// Quarterly returns (24Q / 26Q)
// ---------------------------------------------------------------------------

type DeducteeAgg = {
  party_id: string
  party_name: string
  pan: string
  section: string
  base: number
  tds: number
  doc_count: number
}

async function quarterDetail(quarter: TdsQuarter, financialYear: string, direction: TdsDirection) {
  const months = monthsOfQuarter(quarter, financialYear)
  let rows: any[] = []
  for (const p of months) rows = rows.concat(await tdsDetail(p, direction))
  return rows
}

function aggregateDeductees(rows: any[]): DeducteeAgg[] {
  const map = new Map<string, DeducteeAgg>()
  for (const r of rows) {
    const key = `${r.party_id || r.party_name || "—"}::${r.section}`
    const prev = map.get(key)
    if (prev) {
      prev.base = round2(prev.base + num(r.base))
      prev.tds = round2(prev.tds + num(r.tds))
      prev.doc_count += 1
      if (!prev.pan && r.pan) prev.pan = r.pan
    } else {
      map.set(key, {
        party_id: String(r.party_id || ""),
        party_name: r.party_name || "—",
        pan: r.pan || "",
        section: r.section,
        base: round2(num(r.base)),
        tds: round2(num(r.tds)),
        doc_count: 1,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.tds - a.tds)
}

// ---------------------------------------------------------------------------
// Deductee master (Phase 22-23) — one derived record per party for the whole
// financial year, with its section-wise breakup. Fully derived from the source
// ledgers via tdsDetail; no separate deductee table is maintained.
// ---------------------------------------------------------------------------

export type DeducteeMasterRow = {
  party_id: string
  /** Stable deductee handle shown in the master (party_id, or a name fallback). */
  deductee_id: string
  party_name: string
  pan: string
  pan_status: "Valid" | "Invalid" | "Missing"
  /** TDS deductee entity type resolved from the party's constitution / source. */
  party_type: string
  /** Resident / Non-Resident, from a §195-family section or the party country. */
  resident_status: "Resident" | "Non-Resident"
  /** Nature of payment of the party's primary section, from the rule master. */
  payment_type: string
  sections: string[]
  base: number
  tds: number
  /** Effective blended TDS rate for the party (tds ÷ base). */
  rate: number
  doc_count: number
  quarters: string[]
  breakup: { section: string; base: number; tds: number; doc_count: number; rate: number }[]
}

/** Resident status inferred from the party's country of residence. */
function residentStatusFromCountry(country?: string | null): "Resident" | "Non-Resident" {
  const c = String(country || "").trim().toLowerCase()
  if (!c || c === "india" || c === "in" || c === "ind" || c === "bharat") return "Resident"
  return "Non-Resident"
}

/**
 * Section → nature-of-payment lookup from the configurable rule master, so the
 * deductee master can label each party's payment type without hard-coding it.
 */
async function sectionNatureMap(): Promise<Map<string, string>> {
  const rules = await listTdsRules(false)
  const m = new Map<string, string>()
  for (const r of rules) {
    const key = normSection(r.section)
    if (!m.has(key)) m.set(key, r.nature_of_payment)
  }
  return m
}

/**
 * Batch-load the party master (constitution + country) for the deductees in a
 * direction, so party type / resident status resolve from the SINGLE existing
 * master (customers_vendors) rather than a duplicated deductee table.
 */
async function loadPartyMasters(
  dir: TdsDirection,
  ids: string[],
): Promise<Map<string, { business_constitution: string | null; country: string | null }>> {
  const map = new Map<string, { business_constitution: string | null; country: string | null }>()
  const clean = Array.from(new Set(ids.filter((v) => v && v !== "—")))
  if (clean.length === 0) return map
  const placeholders = clean.map(() => "?").join(",")
  const rows = (await query(
    `SELECT party_id, business_constitution, country FROM customers_vendors WHERE party_id IN (${placeholders})`,
    clean,
  ).catch(() => [])) as any[]
  for (const r of rows) {
    map.set(String(r.party_id), {
      business_constitution: r.business_constitution ?? null,
      country: r.country ?? null,
    })
  }
  return map
}

export async function deducteeMaster(financialYear: string, direction: TdsDirection) {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  if (!FY_RE.test(financialYear)) throw new Error("Financial year must be in YYYY-YY format.")

  const months = monthsOfFy(financialYear)
  let rows: any[] = []
  for (const p of months) rows = rows.concat(await tdsDetail(p, dir))

  const map = new Map<string, DeducteeMasterRow>()
  for (const r of rows) {
    const key = String(r.party_id || r.party_name || "—")
    const quarter = quarterOfPeriod(String(r.doc_date).slice(0, 7))
    let party = map.get(key)
    if (!party) {
      party = {
        party_id: String(r.party_id || ""),
        deductee_id: String(r.party_id || key),
        party_name: r.party_name || "—",
        pan: r.pan || "",
        pan_status: (r.pan_status as DeducteeMasterRow["pan_status"]) || (r.pan ? "Valid" : "Missing"),
        party_type: "Any",
        resident_status: "Resident",
        payment_type: "—",
        sections: [],
        base: 0,
        tds: 0,
        rate: 0,
        doc_count: 0,
        quarters: [],
        breakup: [],
      }
      map.set(key, party)
    }
    if (!party.pan && r.pan) {
      party.pan = r.pan
      party.pan_status = (r.pan_status as DeducteeMasterRow["pan_status"]) || "Valid"
    }
    party.base = round2(party.base + num(r.base))
    party.tds = round2(party.tds + num(r.tds))
    party.doc_count += 1
    if (r.section && !party.sections.includes(r.section)) party.sections.push(r.section)
    if (quarter && !party.quarters.includes(quarter)) party.quarters.push(quarter)

    const bucket = party.breakup.find((b) => b.section === r.section)
    if (bucket) {
      bucket.base = round2(bucket.base + num(r.base))
      bucket.tds = round2(bucket.tds + num(r.tds))
      bucket.doc_count += 1
    } else {
      party.breakup.push({ section: r.section, base: round2(num(r.base)), tds: round2(num(r.tds)), doc_count: 1, rate: 0 })
    }
  }

  const deductees = Array.from(map.values()).sort((a, b) => b.tds - a.tds)
  for (const d of deductees) {
    d.sections.sort()
    d.quarters.sort()
    d.breakup.sort((a, b) => b.tds - a.tds)
    for (const b of d.breakup) b.rate = b.base > 0 ? round2((b.tds / b.base) * 100) : 0
  }

  // Phase 22–23 — resolve deductee details (party type, resident status, payment
  // type, effective rate) from the SINGLE existing masters + rule master. No
  // separate deductee table is created; everything is derived.
  const natureBySection = await sectionNatureMap()
  const partyMasters = await loadPartyMasters(dir, deductees.map((d) => d.party_id))
  for (const d of deductees) {
    d.rate = d.base > 0 ? round2((d.tds / d.base) * 100) : 0
    const primarySection = d.breakup[0]?.section || d.sections[0] || ""
    d.payment_type = natureBySection.get(normSection(primarySection)) || "—"
    const nonResidentSection = d.sections.some((s) => NON_RESIDENT_SECTIONS.has(normSection(s)))
    const master = partyMasters.get(d.party_id)
    if (dir === "employee") {
      // Employee (§192 salary) and freelance payees are individuals by nature.
      d.party_type = "Individual/HUF"
    } else {
      d.party_type = entityTypeForConstitution(master?.business_constitution)
    }
    d.resident_status = nonResidentSection ? "Non-Resident" : residentStatusFromCountry(master?.country)
  }

  const totals = {
    party_count: deductees.length,
    base: round2(deductees.reduce((s, d) => s + d.base, 0)),
    tds: round2(deductees.reduce((s, d) => s + d.tds, 0)),
    pan_issues: deductees.filter((d) => d.pan_status !== "Valid").length,
  }

  return { financial_year: financialYear, direction: dir, deductees, totals }
}

export async function prepareTdsReturn(quarter: TdsQuarter, financialYear: string, direction: TdsDirection) {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  if (!isDeductorDirection(dir)) {
    throw new Error("Returns are filed only for TDS you deduct (payable / employee). Receivable TDS is a Form 26AS credit.")
  }
  if (!FY_RE.test(financialYear)) throw new Error("Financial year must be in YYYY-YY format.")

  const formType = returnFormFor(dir)
  const months = monthsOfQuarter(quarter, financialYear)
  const detail = await quarterDetail(quarter, financialYear, dir)
  const deductees = aggregateDeductees(detail)

  const sectionsMap = new Map<string, { section: string; base: number; tds: number; doc_count: number }>()
  for (const d of deductees) {
    const prev = sectionsMap.get(d.section)
    if (prev) {
      prev.base = round2(prev.base + d.base)
      prev.tds = round2(prev.tds + d.tds)
      prev.doc_count += d.doc_count
    } else {
      sectionsMap.set(d.section, { section: d.section, base: d.base, tds: d.tds, doc_count: d.doc_count })
    }
  }
  const sections = Array.from(sectionsMap.values()).sort((a, b) => b.tds - a.tds)

  const challans = (await listChallans(dir, financialYear)).filter((c) => months.includes(c.period))
  const deposited = round2(challans.reduce((s, c) => s + c.tds_amount, 0))
  const totalDeducted = round2(deductees.reduce((s, d) => s + d.tds, 0))
  const totalBase = round2(deductees.reduce((s, d) => s + d.base, 0))

  const [existing] = (await query(
    `SELECT * FROM tds_returns WHERE form_type = ? AND quarter = ? AND financial_year = ? LIMIT 1`,
    [formType, quarter, financialYear],
  )) as any[]

  const deductor = await getDeductorIdentity()

  return {
    form_type: formType,
    direction: dir,
    deductor,
    quarter,
    financial_year: financialYear,
    months,
    sections,
    deductees,
    challans,
    totals: {
      total_base: totalBase,
      total_deducted: totalDeducted,
      total_deposited: deposited,
      deductee_count: deductees.length,
      balance: round2(totalDeducted - deposited),
    },
    due_date: returnDueDate(quarter, financialYear),
    return: existing
      ? {
          return_id: existing.return_id,
          status: existing.status,
          token_no: existing.token_no,
          filed_at: existing.filed_at,
          total_deducted: num(existing.total_deducted),
          total_deposited: num(existing.total_deposited),
        }
      : null,
  }
}

export async function listTdsReturns(direction?: TdsDirection) {
  await ensureTdsComplianceSchema()
  const rows = (await query(
    `SELECT * FROM tds_returns ${direction ? "WHERE direction = ?" : ""} ORDER BY financial_year DESC, quarter DESC, id DESC LIMIT 200`,
    direction ? [normDirection(direction)] : [],
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    id: Number(r.id),
    return_id: r.return_id,
    form_type: r.form_type,
    direction: r.direction,
    quarter: r.quarter,
    financial_year: r.financial_year,
    total_base: round2(num(r.total_base)),
    total_deducted: round2(num(r.total_deducted)),
    total_deposited: round2(num(r.total_deposited)),
    deductee_count: Number(r.deductee_count || 0),
    status: r.status,
    token_no: r.token_no ?? null,
    arn: r.arn ?? null,
    challan_label: r.challan_label ?? null,
    original_return_id: r.original_return_id ?? null,
    correction_type: r.correction_type ?? null,
    revision_no: Number(r.revision_no || 0),
    is_correction: Number(r.is_correction || 0) === 1,
    remarks: r.remarks ?? null,
    filed_at: r.filed_at ? new Date(r.filed_at).toISOString() : null,
    allowed_transitions: allowedReturnTransitions(String(r.status)),
  }))
}

// ---------------------------------------------------------------------------
// Pre-filing validation (Phase 36 preparation checks + Phase 37 blocking errors)
// ---------------------------------------------------------------------------

export type TdsValidationIssue = {
  code: string
  severity: "error" | "warning"
  message: string
  party_name?: string
  section?: string
}

/**
 * Validate a quarter's return before it can be filed. Errors block filing
 * (Phase 37); warnings are advisory. Every check is derived from the same
 * deductee ledger + challans the return itself is built from, plus the
 * deductor's statutory identity (TAN/PAN) and the configurable rule master, so
 * nothing is captured twice.
 */
export async function validateTdsReturn(quarter: TdsQuarter, financialYear: string, direction: TdsDirection) {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  if (!isDeductorDirection(dir)) {
    return {
      quarter,
      financial_year: financialYear,
      direction: dir,
      issues: [
        {
          code: "not_a_deductor",
          severity: "warning" as const,
          message: "Receivable TDS is a Form 26AS credit — no return is filed for this direction.",
        },
      ],
      error_count: 0,
      warning_count: 1,
      can_file: false,
    }
  }

  const prep = await prepareTdsReturn(quarter, financialYear, dir)
  const rules = await listTdsRules(false).catch(() => [])
  const ruleSections = new Set(rules.map((r) => normSection(r.section)))
  const rateBySection = new Map<string, number[]>()
  for (const r of rules) {
    const key = normSection(r.section)
    const arr = rateBySection.get(key) ?? []
    arr.push(num(r.rate), num(r.rate_no_pan))
    rateBySection.set(key, arr)
  }

  const issues: TdsValidationIssue[] = []

  // Deductor identity — TAN / PAN are stamped onto every return (Phase 36/37).
  if (!prep.deductor.tan) {
    issues.push({ code: "tan_missing", severity: "error", message: "Deductor TAN is not set in Company Settings → TDS Deductor." })
  } else if (!/^[A-Z]{4}\d{5}[A-Z]$/.test(prep.deductor.tan)) {
    issues.push({ code: "tan_invalid", severity: "error", message: `Deductor TAN "${prep.deductor.tan}" is not a valid 10-character TAN.` })
  }
  if (!prep.deductor.pan) {
    issues.push({ code: "deductor_pan_missing", severity: "warning", message: "Deductor PAN is not set in Company Settings." })
  }

  // Nothing to file.
  if (prep.deductees.length === 0) {
    issues.push({ code: "no_deductee", severity: "error", message: `No TDS deductions found for ${quarter} ${financialYear}.` })
  }

  // Deductee-level checks (Phase 37): PAN, section, rate, amount.
  const seen = new Map<string, number>()
  for (const d of prep.deductees) {
    const pan = normalizePan(d.pan)
    const ps = panStatus(pan)
    if (ps === "Missing") {
      issues.push({ code: "pan_missing", severity: "error", message: `PAN missing for ${d.party_name} (${d.section}).`, party_name: d.party_name, section: d.section })
    } else if (ps === "Invalid") {
      issues.push({ code: "pan_invalid", severity: "error", message: `Invalid PAN "${pan}" for ${d.party_name} (${d.section}).`, party_name: d.party_name, section: d.section })
    }

    const sec = normSection(d.section)
    if (!sec || sec === "UNSPECIFIED") {
      issues.push({ code: "section_missing", severity: "error", message: `Missing TDS section for ${d.party_name}.`, party_name: d.party_name })
    } else if (ruleSections.size > 0 && !ruleSections.has(sec)) {
      issues.push({ code: "section_unknown", severity: "warning", message: `Section ${d.section} for ${d.party_name} is not in the Rule Master.`, party_name: d.party_name, section: d.section })
    }

    if (d.tds <= 0) {
      issues.push({ code: "amount_zero", severity: "warning", message: `Zero TDS deducted for ${d.party_name} (${d.section}).`, party_name: d.party_name, section: d.section })
    }
    // Effective rate sanity vs the rule master (Phase 37 "wrong rate").
    if (d.base > 0 && sec && rateBySection.has(sec)) {
      const effective = round2((d.tds / d.base) * 100)
      const allowed = rateBySection.get(sec) ?? []
      const near = allowed.some((r) => Math.abs(r - effective) <= 0.5)
      if (!near && effective > 0) {
        issues.push({
          code: "rate_mismatch",
          severity: "warning",
          message: `Effective rate ${effective}% for ${d.party_name} (${d.section}) does not match any Rule Master rate.`,
          party_name: d.party_name,
          section: d.section,
        })
      }
    }

    const key = `${normalizePan(d.pan) || d.party_name}::${sec}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      issues.push({ code: "duplicate_deductee", severity: "warning", message: `Duplicate deductee/section entry (${key.replace("::", " · ")}) appears ${count} times.` })
    }
  }

  // Challan / payment coverage (Phase 37 "missing challan / missing payment / mismatch").
  if (prep.totals.total_deducted > 0 && prep.totals.total_deposited <= 0) {
    issues.push({ code: "challan_missing", severity: "error", message: "No challan deposited for this quarter — record the TDS deposit before filing." })
  } else if (prep.totals.balance > 0.5) {
    issues.push({ code: "amount_mismatch", severity: "error", message: `Deducted ${prep.totals.total_deducted} exceeds deposited ${prep.totals.total_deposited} by ${prep.totals.balance}.` })
  } else if (prep.totals.balance < -0.5) {
    issues.push({ code: "amount_mismatch", severity: "warning", message: `Deposited ${prep.totals.total_deposited} exceeds deducted ${prep.totals.total_deducted}.` })
  }

  const errorCount = issues.filter((i) => i.severity === "error").length
  const warningCount = issues.filter((i) => i.severity === "warning").length
  return {
    quarter,
    financial_year: financialYear,
    direction: dir,
    form_type: prep.form_type,
    already_filed: !!prep.return,
    issues,
    error_count: errorCount,
    warning_count: warningCount,
    can_file: errorCount === 0 && prep.deductees.length > 0 && !prep.return,
  }
}

export async function fileTdsReturn(
  quarter: TdsQuarter,
  financialYear: string,
  direction: TdsDirection,
  tokenNo: string | null,
  actorId?: number | null,
) {
  await ensureTdsComplianceSchema()
  const prep = await prepareTdsReturn(quarter, financialYear, direction)
  if (prep.return) throw new Error(`${prep.form_type} for ${quarter} ${financialYear} is already filed.`)
  if (prep.totals.deductee_count === 0) throw new Error("No TDS deductions found for this quarter; nothing to file.")

  // Phase 37 — filing is blocked while any error-level validation issue remains.
  const validation = await validateTdsReturn(quarter, financialYear, direction)
  if (validation.error_count > 0) {
    throw new Error(`Cannot file: ${validation.error_count} validation error(s) must be resolved first.`)
  }

  const returnId = await nextRecordId("TDR")
  const arn = generateAckNumber(prep.form_type)
  const challanLabel = await quarterChallanLabel(quarter, financialYear, prep.direction as TdsDirection)
  await query(
    `INSERT INTO tds_returns
       (return_id, form_type, direction, quarter, financial_year, total_base, total_deducted, total_deposited,
        deductee_count, status, token_no, arn, challan_label, revision_no, is_correction, snapshot, filed_at, filed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,NOW(),?)`,
    [
      returnId, prep.form_type, prep.direction, quarter, financialYear, prep.totals.total_base,
      prep.totals.total_deducted, prep.totals.total_deposited, prep.totals.deductee_count,
      "Filed", tokenNo || null, arn, challanLabel || null, JSON.stringify(prep), actorId ?? null,
    ],
  )
  await logFinanceEvent({
    entityType: "tds_return",
    entityRef: returnId,
    type: "posted",
    summary: `${prep.form_type} filed for ${quarter} ${financialYear}: deducted ${prep.totals.total_deducted}, deposited ${prep.totals.total_deposited} (ARN ${arn})`,
    amount: prep.totals.total_deducted,
    actorId: actorId ?? null,
  })
  return { return_id: returnId, form_type: prep.form_type, quarter, financial_year: financialYear, arn }
}

/** A deterministic-looking acknowledgement/token reference for a filed return. */
function generateAckNumber(formType: string): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-6)
  const rand = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, "0")
  return `ACK${formType.replace(/[^0-9A-Z]/gi, "")}${ts}${rand}`
}

/** The comma-joined challan references that cover a quarter, for filing history. */
async function quarterChallanLabel(quarter: TdsQuarter, financialYear: string, direction: TdsDirection): Promise<string> {
  const dir = normDirection(direction)
  if (!isDeductorDirection(dir)) return ""
  const label = new Set<string>()
  for (const period of monthsOfQuarter(quarter, financialYear)) {
    const rows = (await query(
      `SELECT DISTINCT c.challan_no
         FROM tds_challans c
         JOIN tds_challan_allocations a ON a.challan_id = c.id
        WHERE a.period = ? AND a.direction = ? AND c.challan_no IS NOT NULL AND c.challan_no <> ''`,
      [period, dir],
    ).catch(() => [])) as any[]
    for (const r of rows) if (r.challan_no) label.add(String(r.challan_no))
  }
  return Array.from(label).join(", ")
}

/**
 * Move a filed/prepared return to another lifecycle state (Phase 38). Only the
 * transitions declared in RETURN_TRANSITIONS are allowed; an ARN or remark can
 * be attached (e.g. a rejection reason). History is preserved — this never
 * deletes a row.
 */
export async function setReturnStatus(
  returnId: string,
  target: TdsReturnStatus,
  opts: { actorId?: number | null; remarks?: string | null; arn?: string | null } = {},
) {
  await ensureTdsComplianceSchema()
  const [row] = (await query(`SELECT * FROM tds_returns WHERE return_id = ? LIMIT 1`, [returnId]).catch(() => [])) as any[]
  if (!row) throw new Error("Return not found.")
  const from = String(row.status)
  if (from === target) return { return_id: returnId, status: target }
  if (!allowedReturnTransitions(from).includes(target)) {
    throw new Error(`Cannot move a ${from} return to ${target}.`)
  }
  await query(
    `UPDATE tds_returns SET status = ?, remarks = COALESCE(?, remarks), arn = COALESCE(?, arn) WHERE return_id = ?`,
    [target, opts.remarks ?? null, opts.arn ?? null, returnId],
  )
  await logFinanceEvent({
    entityType: "tds_return",
    entityRef: returnId,
    type: "updated",
    summary: `${row.form_type} ${row.quarter} ${row.financial_year} moved ${from} → ${target}${opts.remarks ? ` (${opts.remarks})` : ""}`,
    actorId: opts.actorId ?? null,
  }).catch(() => {})
  return { return_id: returnId, status: target }
}

/**
 * File a correction/revised return (Phase 40). The ORIGINAL is preserved and
 * flagged "Correction Required"; a NEW return row is created carrying the
 * correction linkage (original id, correction type, incremented revision) and
 * recomputed figures from the current ledger. The original is never overwritten.
 */
export async function createReturnCorrection(opts: {
  originalReturnId: string
  correctionType?: string
  tokenNo?: string | null
  remarks?: string | null
  actorId?: number | null
}) {
  await ensureTdsComplianceSchema()
  const [orig] = (await query(`SELECT * FROM tds_returns WHERE return_id = ? LIMIT 1`, [opts.originalReturnId]).catch(
    () => [],
  )) as any[]
  if (!orig) throw new Error("Original return not found.")
  if (["Cancelled"].includes(String(orig.status))) throw new Error("A cancelled return cannot be corrected.")

  const quarter = String(orig.quarter) as TdsQuarter
  const financialYear = String(orig.financial_year)
  const direction = String(orig.direction) as TdsDirection
  const prep = await prepareTdsReturn(quarter, financialYear, direction)

  const rootId = orig.original_return_id || orig.return_id
  const priorRevisions = (await query(
    `SELECT COALESCE(MAX(revision_no),0) AS mx FROM tds_returns WHERE original_return_id = ? OR return_id = ?`,
    [rootId, rootId],
  ).catch(() => [{ mx: 0 }])) as any[]
  const revisionNo = Number(priorRevisions[0]?.mx || 0) + 1
  const correctionType = opts.correctionType || `C${revisionNo}`

  const returnId = await nextRecordId("TDR")
  const arn = generateAckNumber(String(orig.form_type))
  const challanLabel = await quarterChallanLabel(quarter, financialYear, direction)
  await query(
    `INSERT INTO tds_returns
       (return_id, form_type, direction, quarter, financial_year, total_base, total_deducted, total_deposited,
        deductee_count, status, token_no, arn, challan_label, original_return_id, correction_type, revision_no,
        is_correction, remarks, snapshot, filed_at, filed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,NOW(),?)`,
    [
      returnId, orig.form_type, normDirection(direction), quarter, financialYear, prep.totals.total_base,
      prep.totals.total_deducted, prep.totals.total_deposited, prep.totals.deductee_count, "Filed",
      opts.tokenNo || null, arn, challanLabel || null, rootId, correctionType, revisionNo,
      opts.remarks ?? null, JSON.stringify(prep), opts.actorId ?? null,
    ],
  )
  // Flag the original so history clearly shows it was superseded.
  await query(`UPDATE tds_returns SET status = 'Correction Required' WHERE return_id = ? AND status = 'Filed'`, [
    orig.return_id,
  ]).catch(() => {})
  await logFinanceEvent({
    entityType: "tds_return",
    entityRef: returnId,
    type: "posted",
    summary: `Correction ${correctionType} (rev ${revisionNo}) of ${orig.return_id} — ${orig.form_type} ${quarter} ${financialYear}`,
    amount: prep.totals.total_deducted,
    actorId: opts.actorId ?? null,
  }).catch(() => {})
  return { return_id: returnId, original_return_id: rootId, correction_type: correctionType, revision_no: revisionNo, arn }
}

// ---------------------------------------------------------------------------
// Certificates (Form 16A quarterly non-salary, Form 16 annual salary)
// ---------------------------------------------------------------------------

export type CertificateForm = "16" | "16A"

/**
 * Build the deductee-wise certificate roster for a period.
 *  - "16A": non-salary sections (everything except §192) across a quarter.
 *  - "16" : salary §192 across the whole financial year (annual).
 */
export async function previewCertificates(opts: {
  formType: CertificateForm
  direction: TdsDirection
  quarter?: TdsQuarter
  financialYear: string
}) {
  await ensureTdsComplianceSchema()
  const dir = normDirection(opts.direction)
  if (!isDeductorDirection(dir)) {
    throw new Error("Certificates are issued only for TDS you deduct. Receivable TDS certificates come from your customers.")
  }
  if (!FY_RE.test(opts.financialYear)) throw new Error("Financial year must be in YYYY-YY format.")

  let rows: any[] = []
  if (opts.formType === "16") {
    for (const p of monthsOfFy(opts.financialYear)) rows = rows.concat(await tdsDetail(p, dir))
    rows = rows.filter((r) => String(r.section) === "192")
  } else {
    if (!opts.quarter) throw new Error("Form 16A requires a quarter.")
    rows = (await quarterDetail(opts.quarter, opts.financialYear, dir)).filter((r) => String(r.section) !== "192")
  }

  const map = new Map<string, { party_id: string; party_name: string; pan: string; sections: Set<string>; base: number; tds: number; doc_count: number }>()
  for (const r of rows) {
    const key = String(r.party_id || r.party_name || "—")
    const prev = map.get(key)
    if (prev) {
      prev.base = round2(prev.base + num(r.base))
      prev.tds = round2(prev.tds + num(r.tds))
      prev.doc_count += 1
      prev.sections.add(String(r.section))
      if (!prev.pan && r.pan) prev.pan = r.pan
    } else {
      map.set(key, {
        party_id: String(r.party_id || ""),
        party_name: r.party_name || "—",
        pan: r.pan || "",
        sections: new Set([String(r.section)]),
        base: round2(num(r.base)),
        tds: round2(num(r.tds)),
        doc_count: 1,
      })
    }
  }

  const quarter = opts.formType === "16A" ? opts.quarter ?? null : null
  const deductor = await getDeductorIdentity()
  const existing = (await query(
    `SELECT party_id, certificate_id, status FROM tds_certificates
       WHERE form_type = ? AND financial_year = ? AND ${quarter ? "quarter = ?" : "quarter IS NULL"}`,
    quarter ? [opts.formType, opts.financialYear, quarter] : [opts.formType, opts.financialYear],
  ).catch(() => [])) as any[]
  const issuedBy = new Map(existing.map((e) => [String(e.party_id || ""), e]))

  const deductees = Array.from(map.values())
    .map((d) => {
      const iss = issuedBy.get(d.party_id)
      return {
        party_id: d.party_id,
        party_name: d.party_name,
        pan: d.pan,
        sections: Array.from(d.sections).join(", "),
        base: d.base,
        tds: d.tds,
        doc_count: d.doc_count,
        issued: !!iss,
        certificate_id: iss?.certificate_id ?? null,
        status: iss?.status ?? "Pending",
      }
    })
    .sort((a, b) => b.tds - a.tds)

  return {
    form_type: opts.formType,
    direction: dir,
    deductor,
    quarter,
    financial_year: opts.financialYear,
    deductees,
    totals: {
      deductee_count: deductees.length,
      total_base: round2(deductees.reduce((s, d) => s + d.base, 0)),
      total_tds: round2(deductees.reduce((s, d) => s + d.tds, 0)),
      issued_count: deductees.filter((d) => d.issued).length,
    },
  }
}

export async function generateCertificates(opts: {
  formType: CertificateForm
  direction: TdsDirection
  quarter?: TdsQuarter
  financialYear: string
  actorId?: number | null
}) {
  const preview = await previewCertificates(opts)
  const dir = preview.direction
  const quarter = preview.quarter
  let created = 0

  for (const d of preview.deductees) {
    if (d.issued || d.tds <= 0) continue
    const certificateId = await nextRecordId("TCR")
    try {
      await query(
        `INSERT INTO tds_certificates
           (certificate_id, form_type, direction, quarter, financial_year, party_id, party_name, pan,
            sections, total_base, total_tds, status, snapshot, issued_at, issued_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`,
        [
          certificateId, opts.formType, dir, quarter, opts.financialYear, d.party_id || null, d.party_name,
          d.pan || null, d.sections, d.base, d.tds, "Generated",
          JSON.stringify({ ...d, deductor: preview.deductor, form_type: opts.formType, financial_year: opts.financialYear, quarter }),
          opts.actorId ?? null,
        ],
      )
      created += 1
    } catch {
      // Unique (form/fy/quarter/party) — skip a race duplicate.
    }
  }

  await logFinanceEvent({
    entityType: "tds_certificate",
    entityRef: `${opts.formType}:${opts.financialYear}:${quarter ?? "annual"}`,
    type: "issued",
    summary: `Issued ${created} Form ${opts.formType} certificate(s) for ${quarter ? `${quarter} ` : ""}${opts.financialYear}`,
    amount: preview.totals.total_tds,
    actorId: opts.actorId ?? null,
  })
  return { created }
}

export async function listCertificates(direction: TdsDirection, financialYear?: string) {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  const rows = (await query(
    `SELECT * FROM tds_certificates
       WHERE direction = ? ${financialYear ? "AND financial_year = ?" : ""}
       ORDER BY financial_year DESC, quarter DESC, total_tds DESC, id DESC LIMIT 400`,
    financialYear ? [dir, financialYear] : [dir],
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    id: Number(r.id),
    certificate_id: r.certificate_id,
    form_type: r.form_type,
    quarter: r.quarter ?? null,
    financial_year: r.financial_year,
    party_name: r.party_name || "—",
    pan: r.pan ?? null,
    sections: r.sections ?? null,
    total_base: round2(num(r.total_base)),
    total_tds: round2(num(r.total_tds)),
    status: r.status,
    remarks: r.remarks ?? null,
    corrected_from: r.corrected_from ?? null,
    corrected_at: r.corrected_at ? new Date(r.corrected_at).toISOString() : null,
    issued_at: r.issued_at ? new Date(r.issued_at).toISOString() : null,
    allowed_transitions: allowedCertificateTransitions(String(r.status)),
  }))
}

// ---------------------------------------------------------------------------
// Certificate status lifecycle (Phase 35)
// ---------------------------------------------------------------------------

export const TDS_CERTIFICATE_STATUSES = ["Pending", "Generated", "Issued", "Corrected"] as const
export type TdsCertificateStatus = (typeof TDS_CERTIFICATE_STATUSES)[number]

const CERTIFICATE_TRANSITIONS: Record<string, TdsCertificateStatus[]> = {
  Generated: ["Issued", "Corrected"],
  Issued: ["Corrected"],
  Corrected: ["Issued"],
}

export function allowedCertificateTransitions(status: string): TdsCertificateStatus[] {
  return CERTIFICATE_TRANSITIONS[status] ?? []
}

/** Move a certificate Generated → Issued (delivered to the deductee), etc. */
export async function setCertificateStatus(
  certificateId: string,
  target: TdsCertificateStatus,
  opts: { actorId?: number | null; remarks?: string | null } = {},
) {
  await ensureTdsComplianceSchema()
  const [row] = (await query(`SELECT * FROM tds_certificates WHERE certificate_id = ? LIMIT 1`, [certificateId]).catch(
    () => [],
  )) as any[]
  if (!row) throw new Error("Certificate not found.")
  const from = String(row.status)
  if (from === target) return { certificate_id: certificateId, status: target }
  if (!allowedCertificateTransitions(from).includes(target)) {
    throw new Error(`Cannot move a ${from} certificate to ${target}.`)
  }
  await query(`UPDATE tds_certificates SET status = ?, remarks = COALESCE(?, remarks) WHERE certificate_id = ?`, [
    target,
    opts.remarks ?? null,
    certificateId,
  ])
  await logFinanceEvent({
    entityType: "tds_certificate",
    entityRef: certificateId,
    type: "updated",
    summary: `Certificate ${certificateId} moved ${from} → ${target}`,
    actorId: opts.actorId ?? null,
  }).catch(() => {})
  return { certificate_id: certificateId, status: target }
}

/**
 * Re-issue a corrected certificate (Phase 35). Recomputes the deductee's base/TDS
 * from the CURRENT ledger and rewrites the same certificate row in place, marking
 * it "Corrected" and stamping the correction time. The unique
 * (form/fy/quarter/party) key means a correction is a re-issue, never a duplicate.
 */
export async function correctCertificate(certificateId: string, opts: { actorId?: number | null; remarks?: string | null } = {}) {
  await ensureTdsComplianceSchema()
  const [row] = (await query(`SELECT * FROM tds_certificates WHERE certificate_id = ? LIMIT 1`, [certificateId]).catch(
    () => [],
  )) as any[]
  if (!row) throw new Error("Certificate not found.")

  const preview = await previewCertificates({
    formType: String(row.form_type) as CertificateForm,
    direction: String(row.direction) as TdsDirection,
    quarter: (row.quarter ?? undefined) as TdsQuarter | undefined,
    financialYear: String(row.financial_year),
  })
  const match = preview.deductees.find((d) => String(d.party_id || "") === String(row.party_id || "") || d.party_name === row.party_name)
  if (!match) throw new Error("This deductee no longer has TDS in the current ledger — nothing to correct.")

  await query(
    `UPDATE tds_certificates
        SET total_base = ?, total_tds = ?, sections = ?, pan = ?, status = 'Corrected',
            corrected_from = COALESCE(corrected_from, ?), corrected_at = NOW(),
            remarks = COALESCE(?, remarks),
            snapshot = ?
      WHERE certificate_id = ?`,
    [
      match.base, match.tds, match.sections, match.pan || null, row.certificate_id,
      opts.remarks ?? null,
      JSON.stringify({ ...match, deductor: preview.deductor, form_type: row.form_type, financial_year: row.financial_year, quarter: row.quarter ?? null, corrected: true }),
      certificateId,
    ],
  )
  await logFinanceEvent({
    entityType: "tds_certificate",
    entityRef: certificateId,
    type: "updated",
    summary: `Corrected certificate ${certificateId} — base ${match.base}, TDS ${match.tds}`,
    amount: match.tds,
    actorId: opts.actorId ?? null,
  }).catch(() => {})
  return { certificate_id: certificateId, status: "Corrected", total_tds: match.tds }
}

// ---------------------------------------------------------------------------
// Reconciliation (three-way: deducted vs deposited vs reported)
// ---------------------------------------------------------------------------

export type TdsReconRow = {
  quarter: TdsQuarter
  deducted: number
  deposited: number
  returned: number
  certified: number
  deposit_variance: number
  return_variance: number
  status: string
}

export async function tdsReconciliation(financialYear: string, direction: TdsDirection) {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  if (!FY_RE.test(financialYear)) throw new Error("Financial year must be in YYYY-YY format.")

  const deposits = isDeductorDirection(dir) ? await depositByPeriod(dir, financialYear) : {}
  const returns = await listTdsReturns(dir)
  const certificates = await listCertificates(dir, financialYear)

  const quarters: TdsQuarter[] = ["Q1", "Q2", "Q3", "Q4"]
  const rows: TdsReconRow[] = []
  for (const q of quarters) {
    const months = monthsOfQuarter(q, financialYear)
    let deducted = 0
    for (const p of months) {
      const summary = await tdsSummary(p, dir)
      deducted += summary.totals.total_tds
    }
    deducted = round2(deducted)
    const deposited = round2(months.reduce((s, p) => s + (deposits[p] || 0), 0))
    const ret = returns.find((r) => r.quarter === q && r.financial_year === financialYear)
    const returned = round2(ret ? ret.total_deducted : 0)
    const certified = round2(
      certificates.filter((c) => c.quarter === q).reduce((s, c) => s + c.total_tds, 0),
    )
    const depositVariance = round2(deducted - deposited)
    const returnVariance = round2(deducted - returned)

    let status = "Balanced"
    if (deducted === 0) status = "Nil"
    else if (!isDeductorDirection(dir)) status = "Credit"
    else if (Math.abs(depositVariance) > 0.5 || Math.abs(returnVariance) > 0.5) status = "Mismatch"

    rows.push({
      quarter: q,
      deducted,
      deposited,
      returned,
      certified,
      deposit_variance: depositVariance,
      return_variance: returnVariance,
      status,
    })
  }

  const totals = {
    deducted: round2(rows.reduce((s, r) => s + r.deducted, 0)),
    deposited: round2(rows.reduce((s, r) => s + r.deposited, 0)),
    returned: round2(rows.reduce((s, r) => s + r.returned, 0)),
    certified: round2(rows.reduce((s, r) => s + r.certified, 0)),
  }
  return { financial_year: financialYear, direction: dir, deposit_applicable: isDeductorDirection(dir), rows, totals }
}
