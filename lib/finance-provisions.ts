import { query } from "@/lib/db"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { ensureRegisterPostingAccounts } from "@/lib/finance-accounts"
import { ensureProvisionsAccrualsColumns } from "@/lib/finance-ensure"

// ---------------------------------------------------------------------------
// Provisions & Accruals — automatic periodic posting engine (Phase 6).
//
// A provision document establishes a balance-sheet position once (handled by
// the shared register-posting engine). This module owns the *periodic* side of
// the same document: it spreads the recognition across the configured Start →
// End window at the chosen frequency, and posts each due installment as its own
// balanced Journal → General Ledger voucher through the shared posting engine.
//
//   Prepaid Expense       → Dr Expense           ; Cr Prepaid Asset   (amortise)
//   Recurring Provision   → Dr Expense           ; Cr Provision Liab.  (re-book)
//   Recurring Accrual exp → Dr Expense           ; Cr Accrued Liab.    (re-book)
//   Recurring Accrual inc → Dr Accrued Asset      ; Cr Income           (re-book)
//
// Every installment is idempotent: a schedule row is posted at most once (it
// carries its own voucher_no) and a transient failure leaves it Pending for the
// next cron run to retry.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const today = () => new Date().toISOString().slice(0, 10)
const dateOf = (v: any) => String(v || today()).slice(0, 10)

export type ProvisionKind = "provision" | "accrual" | "prepaid"

/** Normalise the stored `provision_type` into a posting-shape discriminator. */
export function provisionKind(r: Record<string, any>): ProvisionKind {
  const t = String(r.provision_type || "").trim().toLowerCase()
  if (t.includes("prepaid")) return "prepaid"
  if (t.includes("accrual") || t.includes("accrued")) return "accrual"
  return "provision"
}

const PERIOD_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  "half-yearly": 6,
  "half yearly": 6,
  yearly: 12,
  annually: 12,
}

function periodMonths(period: string | null | undefined): number {
  return PERIOD_MONTHS[String(period || "").trim().toLowerCase()] ?? 0
}

const isYes = (v: any) => String(v || "").trim().toLowerCase() === "yes"

/** Add whole months to an ISO date, clamping to the end of the target month. */
function addMonths(iso: string, months: number): string {
  const d = new Date(`${dateOf(iso)}T00:00:00Z`)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d.toISOString().slice(0, 10)
}

/** Inclusive whole-month span between two ISO dates (>= 1). */
function inclusiveMonths(startIso: string, endIso: string): number {
  const s = new Date(`${dateOf(startIso)}T00:00:00Z`)
  const e = new Date(`${dateOf(endIso)}T00:00:00Z`)
  const months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1
  return Math.max(1, months)
}

type ScheduleRow = { installmentNo: number; periodDate: string; amount: number }

/**
 * Pure schedule builder. Returns the list of *periodic* installments that must
 * be posted in addition to the one-off recognition voucher.
 *
 *  - Prepaid Expense: the total `amount` is amortised into expense across every
 *    period in the window (installments 1..n).
 *  - Recurring Provision / Accrual: `amount` is the per-period charge; period 1
 *    is the recognition voucher, so installments 2..n are booked here.
 *  - Everything else (one-time provision/accrual): no periodic installments.
 */
export function buildProvisionSchedule(row: Record<string, any>): ScheduleRow[] {
  const kind = provisionKind(row)
  const pm = periodMonths(row.period)
  const start = row.start_date ? dateOf(row.start_date) : dateOf(row.provision_date)
  const end = row.end_date ? dateOf(row.end_date) : null
  if (pm <= 0 || !end) return []

  const totalMonths = inclusiveMonths(start, end)
  const periods = Math.max(1, Math.round(totalMonths / pm))
  const amount = round2(num(row.amount))
  if (amount <= 0 || periods <= 0) return []

  if (kind === "prepaid") {
    // Amortise the total across all periods; the last installment absorbs the
    // rounding remainder so the sum exactly equals the recognised asset.
    const per = round2(amount / periods)
    const rows: ScheduleRow[] = []
    let allocated = 0
    for (let i = 0; i < periods; i++) {
      const last = i === periods - 1
      const value = last ? round2(amount - allocated) : per
      allocated = round2(allocated + value)
      rows.push({ installmentNo: i + 1, periodDate: addMonths(start, i * pm), amount: value })
    }
    return rows
  }

  // Recurring provision / accrual: only re-book when the flag is set. Period 1
  // is already recognised, so emit installments 2..periods, each at `amount`.
  if (!isYes(row.recurring)) return []
  const rows: ScheduleRow[] = []
  for (let i = 1; i < periods; i++) {
    rows.push({ installmentNo: i + 1, periodDate: addMonths(start, i * pm), amount })
  }
  return rows
}

/** Balanced periodic voucher lines for a due installment. */
function periodicLines(row: Record<string, any>, amount: number): PostingLine[] {
  const kind = provisionKind(row)
  const acct = row.account_id || null
  if (kind === "prepaid") {
    return [
      { role: "provision_expense", accountId: acct, debit: amount, credit: 0 },
      { role: "prepaid_asset", debit: 0, credit: amount },
    ]
  }
  if (kind === "accrual") {
    const income = String(row.accrual_nature || "").trim().toLowerCase() === "income"
    return income
      ? [
          { role: "accrued_asset", debit: amount, credit: 0 },
          { role: "accrued_income", accountId: acct, debit: 0, credit: amount },
        ]
      : [
          { role: "provision_expense", accountId: acct, debit: amount, credit: 0 },
          { role: "accrued_liability", debit: 0, credit: amount },
        ]
  }
  return [
    { role: "provision_expense", accountId: acct, debit: amount, credit: 0 },
    { role: "provision_liability", debit: 0, credit: amount },
  ]
}

const UNPOSTABLE_STATUSES = new Set(["Reversed", "Cancelled", "Draft", "Written Off", "Void", "Utilised"])

/**
 * Rebuild the pending schedule for a provision after a create/edit. Posted
 * installments are preserved untouched (their vouchers already live in the
 * ledger); only still-Pending rows are regenerated so an amount/date change is
 * reflected without corrupting history.
 */
export async function syncProvisionSchedule(provisionId: string): Promise<void> {
  await ensureProvisionsAccrualsColumns()
  const [row] = (await query(`SELECT * FROM provisions_accruals WHERE provision_id = ? LIMIT 1`, [provisionId])) as any[]
  if (!row) return

  const posted = (await query(
    `SELECT installment_no FROM provisions_accruals_schedule WHERE provision_id = ? AND posting_status = 'Posted'`,
    [provisionId],
  )) as any[]
  const postedNos = new Set(posted.map((p) => Number(p.installment_no)))

  await query(`DELETE FROM provisions_accruals_schedule WHERE provision_id = ? AND posting_status <> 'Posted'`, [provisionId])

  const status = String(row.status || "").trim()
  if (UNPOSTABLE_STATUSES.has(status)) return

  const schedule = buildProvisionSchedule(row)
  for (const inst of schedule) {
    if (postedNos.has(inst.installmentNo)) continue
    await query(
      `INSERT INTO provisions_accruals_schedule (provision_id, installment_no, period_date, amount, posting_status)
       VALUES (?, ?, ?, ?, 'Pending')
       ON DUPLICATE KEY UPDATE period_date = VALUES(period_date), amount = VALUES(amount)`,
      [provisionId, inst.installmentNo, inst.periodDate, inst.amount],
    )
  }
}

/**
 * Post every installment that is due on or before `asOf` (default: today) and
 * whose parent document is still postable. Safe to run repeatedly — each row is
 * posted at most once. Returns a small run summary for the cron response.
 */
export async function postDueProvisionEntries(opts: { asOf?: string; provisionId?: string; createdBy?: number | null } = {}) {
  await ensureProvisionsAccrualsColumns()
  await ensureRegisterPostingAccounts()
  const asOf = dateOf(opts.asOf || today())

  const params: any[] = [asOf]
  let where = `s.posting_status = 'Pending' AND s.period_date <= ?`
  if (opts.provisionId) {
    where += ` AND s.provision_id = ?`
    params.push(opts.provisionId)
  }

  const due = (await query(
    `SELECT s.*, p.provision_name, p.provision_type, p.accrual_nature, p.account_id, p.account_name,
            p.related_party, p.financial_year, p.status AS parent_status
       FROM provisions_accruals_schedule s
       JOIN provisions_accruals p ON p.provision_id = s.provision_id
      WHERE ${where}
      ORDER BY s.period_date ASC, s.installment_no ASC`,
    params,
  )) as any[]

  let posted = 0
  let skipped = 0
  let failed = 0

  for (const inst of due) {
    if (UNPOSTABLE_STATUSES.has(String(inst.parent_status || "").trim())) {
      skipped++
      continue
    }
    const amount = round2(num(inst.amount))
    if (amount <= 0) {
      skipped++
      continue
    }
    try {
      const result = await postLines(periodicLines(inst, amount), {
        entityType: "provision_accrual_period",
        entityId: Number(inst.id),
        entityRef: `${inst.provision_id}-P${inst.installment_no}`,
        date: dateOf(inst.period_date),
        financialYear: inst.financial_year ?? null,
        partyName: inst.related_party || null,
        voucherType: `${provisionKind(inst) === "prepaid" ? "Prepaid Amortisation" : "Provision Period"}`,
        narration: `Periodic posting ${inst.provision_id} #${inst.installment_no}${inst.provision_name ? ` — ${inst.provision_name}` : ""}`,
        sourceModule: "Provisions & Accruals",
        createdBy: opts.createdBy ?? null,
      })
      await query(
        `UPDATE provisions_accruals_schedule SET posting_status = 'Posted', voucher_no = ?, posted_at = NOW() WHERE id = ?`,
        [result.voucherNo, inst.id],
      )
      posted++
    } catch (error) {
      console.log("[v0] provision periodic posting failed for", inst.provision_id, inst.installment_no, (error as Error)?.message)
      failed++
    }
  }

  return { asOf, due: due.length, posted, skipped, failed }
}

/** Reverse any posted installment vouchers and drop the schedule for a deleted row. */
export async function deleteProvisionSchedule(provisionId: string): Promise<void> {
  await ensureProvisionsAccrualsColumns()
  const [row] = (await query(`SELECT * FROM provisions_accruals WHERE provision_id = ? LIMIT 1`, [provisionId])) as any[]
  const posted = (await query(
    `SELECT * FROM provisions_accruals_schedule WHERE provision_id = ? AND posting_status = 'Posted' AND voucher_no IS NOT NULL`,
    [provisionId],
  )) as any[]

  for (const inst of posted) {
    try {
      const src = row || inst
      await postLines(periodicLines({ ...src, account_id: row?.account_id ?? null }, round2(num(inst.amount))), {
        entityType: "provision_accrual_period",
        entityId: Number(inst.id),
        entityRef: `${inst.provision_id}-P${inst.installment_no}`,
        date: dateOf(inst.period_date),
        financialYear: row?.financial_year ?? null,
        partyName: row?.related_party || null,
        voucherType: "Provision Period Reversal",
        narration: `Reversal of periodic posting ${inst.provision_id} #${inst.installment_no}`,
        sourceModule: "Provisions & Accruals",
        reverse: true,
      })
    } catch (error) {
      console.log("[v0] provision periodic reversal failed for", inst.provision_id, inst.installment_no, (error as Error)?.message)
    }
  }

  await query(`DELETE FROM provisions_accruals_schedule WHERE provision_id = ?`, [provisionId])
}
