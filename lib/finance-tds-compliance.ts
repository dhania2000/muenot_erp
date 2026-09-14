import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"
import { tdsSummary, tdsDetail, type TdsDirection } from "@/lib/finance-tds-filing"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { ensureExpensePostingAccounts } from "@/lib/finance-accounts"

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
export type TdsReturnForm = "24Q" | "26Q"

const normDirection = (d: any): TdsDirection => {
  const s = String(d)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

/** Whether a direction carries a deposit / return obligation on us. */
export function isDeductorDirection(direction: TdsDirection) {
  return direction === "payable" || direction === "employee"
}

/** The statutory return form for a deductor direction. */
export function returnFormFor(direction: TdsDirection): TdsReturnForm {
  return direction === "employee" ? "24Q" : "26Q"
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

  ensured = true
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
  const challanId = await nextRecordId("TCH")

  await query(
    `INSERT INTO tds_challans
       (challan_id, direction, period, quarter, financial_year, bsr_code, challan_no, payment_date,
        tds_amount, interest, late_fee, total_amount, payment_mode, status, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      challanId, dir, input.period, quarter, fy, input.bsrCode || null, input.challanNo || null,
      input.paymentDate || null, tds, interest, lateFee, total, input.paymentMode || null,
      "Deposited", input.note || null, input.actorId ?? null,
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

// ---------------------------------------------------------------------------
// Liability register
// ---------------------------------------------------------------------------

export type TdsLiabilityRow = {
  period: string
  quarter: TdsQuarter
  deducted: number
  deposited: number
  balance: number
  due_date: string
  status: string
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
  const months = monthsOfFy(financialYear)
  const deposits = isDeductorDirection(dir) ? await depositByPeriod(dir, financialYear) : {}

  const rows: TdsLiabilityRow[] = []
  for (const period of months) {
    const summary = await tdsSummary(period, dir)
    const deducted = round2(summary.totals.total_tds)
    const deposited = round2(deposits[period] || 0)
    rows.push({
      period,
      quarter: quarterOfPeriod(period),
      deducted,
      deposited,
      balance: round2(deducted - deposited),
      due_date: depositDueDate(period),
      status: liabilityStatus(dir, deducted, deposited),
    })
  }

  const totals = {
    deducted: round2(rows.reduce((s, r) => s + r.deducted, 0)),
    deposited: round2(rows.reduce((s, r) => s + r.deposited, 0)),
    balance: round2(rows.reduce((s, r) => s + r.balance, 0)),
  }
  return { financial_year: financialYear, direction: dir, deposit_applicable: isDeductorDirection(dir), rows, totals }
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

  return {
    form_type: formType,
    direction: dir,
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
    filed_at: r.filed_at ? new Date(r.filed_at).toISOString() : null,
  }))
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

  const returnId = await nextRecordId("TDR")
  await query(
    `INSERT INTO tds_returns
       (return_id, form_type, direction, quarter, financial_year, total_base, total_deducted, total_deposited,
        deductee_count, status, token_no, snapshot, filed_at, filed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`,
    [
      returnId, prep.form_type, prep.direction, quarter, financialYear, prep.totals.total_base,
      prep.totals.total_deducted, prep.totals.total_deposited, prep.totals.deductee_count,
      "Filed", tokenNo || null, JSON.stringify(prep), actorId ?? null,
    ],
  )
  await logFinanceEvent({
    entityType: "tds_return",
    entityRef: returnId,
    type: "posted",
    summary: `${prep.form_type} filed for ${quarter} ${financialYear}: deducted ${prep.totals.total_deducted}, deposited ${prep.totals.total_deposited}`,
    amount: prep.totals.total_deducted,
    actorId: actorId ?? null,
  })
  return { return_id: returnId, form_type: prep.form_type, quarter, financial_year: financialYear }
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
      }
    })
    .sort((a, b) => b.tds - a.tds)

  return {
    form_type: opts.formType,
    direction: dir,
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
          d.pan || null, d.sections, d.base, d.tds, "Issued", JSON.stringify(d), opts.actorId ?? null,
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
    issued_at: r.issued_at ? new Date(r.issued_at).toISOString() : null,
  }))
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
