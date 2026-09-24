import "server-only"
import { query } from "@/lib/db"
import { isFiscalPeriodClosedOrLocked } from "@/lib/finance/fiscal-year"

/**
 * Accounting period lock — prevents back-dated postings into a closed book.
 *
 * A period is identified by its `YYYY-MM` key (the same key computeExpense
 * stamps onto `accounting_period`). Once finance closes a month, any create /
 * edit / delete / post that would touch a transaction dated in that month is
 * rejected with a PeriodLockedError, so the trial balance for a signed-off
 * period can never move. The table is self-healing (created on first use) and
 * the "is this locked?" check is cached per process for the request path.
 */

export class PeriodLockedError extends Error {
  readonly period: string
  constructor(period: string) {
    super(`Accounting period ${period} is locked. Unlock it before posting or editing transactions in this month.`)
    this.name = "PeriodLockedError"
    this.period = period
  }
}

let schemaEnsured = false
async function ensureSchema() {
  if (schemaEnsured) return
  await query(`CREATE TABLE IF NOT EXISTS finance_period_locks (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    period        VARCHAR(7) NOT NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'Locked',
    note          VARCHAR(500) DEFAULT NULL,
    locked_by     INT DEFAULT NULL,
    locked_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    unlocked_by   INT DEFAULT NULL,
    unlocked_at   DATETIME DEFAULT NULL,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_period (period)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  schemaEnsured = true
}

const MONTH_KEY: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
}

/** Normalise any date-ish or period-ish value into a `YYYY-MM` period key. */
export function periodKeyFor(value?: string | null): string {
  if (!value) return ""
  const s = String(value).trim()
  // Already a period key (YYYY-MM).
  if (/^\d{4}-\d{2}$/.test(s)) return s
  // computeExpense's accounting_period form, e.g. "Sep-2026".
  const mmm = s.match(/^([A-Za-z]{3})-(\d{4})$/)
  if (mmm) {
    const mon = MONTH_KEY[mmm[1].toLowerCase()]
    if (mon) return `${mmm[2]}-${mon}`
  }
  // A full date → reduce to its month.
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  }
  return s.slice(0, 7)
}

/** True when the given date/period falls in a locked accounting month. */
export async function isPeriodLocked(dateOrPeriod?: string | null): Promise<boolean> {
  const period = periodKeyFor(dateOrPeriod)
  if (!period) return false
  await ensureSchema()
  const rows = (await query(
    `SELECT status FROM finance_period_locks WHERE period = ? LIMIT 1`,
    [period],
  )) as any[]
  if (rows.length > 0 && String(rows[0].status) === "Locked") return true
  // Fiscal Year Engine (SPEC 161): a Closed or Locked fiscal period also seals
  // the month, so back-dated postings into it are rejected the same way.
  return await isFiscalPeriodClosedOrLocked(period)
}

/**
 * Throw PeriodLockedError when the date/period is locked. Call this at the top
 * of any mutation that writes a dated financial transaction.
 */
export async function assertPeriodOpen(dateOrPeriod?: string | null): Promise<void> {
  const period = periodKeyFor(dateOrPeriod)
  if (period && (await isPeriodLocked(period))) throw new PeriodLockedError(period)
}

export type PeriodLock = {
  period: string
  status: "Locked" | "Open"
  note: string | null
  locked_by: number | null
  locked_at: string | null
  unlocked_by: number | null
  unlocked_at: string | null
}

/** List all period lock records, most recent month first. */
export async function listPeriodLocks(): Promise<PeriodLock[]> {
  await ensureSchema()
  return (await query(
    `SELECT period, status, note, locked_by, locked_at, unlocked_by, unlocked_at
       FROM finance_period_locks ORDER BY period DESC`,
  )) as any
}

/** Lock a period (idempotent upsert). */
export async function lockPeriod(period: string, opts: { userId?: number | null; note?: string | null } = {}) {
  const key = periodKeyFor(period)
  if (!key) throw new Error("A valid period (YYYY-MM) is required")
  await ensureSchema()
  await query(
    `INSERT INTO finance_period_locks (period, status, note, locked_by, locked_at)
       VALUES (?, 'Locked', ?, ?, NOW())
     ON DUPLICATE KEY UPDATE status = 'Locked', note = VALUES(note), locked_by = VALUES(locked_by), locked_at = NOW()`,
    [key, opts.note ?? null, opts.userId ?? null],
  )
  return { period: key, status: "Locked" as const }
}

/** Unlock (re-open) a period. */
export async function unlockPeriod(period: string, opts: { userId?: number | null } = {}) {
  const key = periodKeyFor(period)
  if (!key) throw new Error("A valid period (YYYY-MM) is required")
  await ensureSchema()
  await query(
    `INSERT INTO finance_period_locks (period, status, unlocked_by, unlocked_at)
       VALUES (?, 'Open', ?, NOW())
     ON DUPLICATE KEY UPDATE status = 'Open', unlocked_by = VALUES(unlocked_by), unlocked_at = NOW()`,
    [key, opts.userId ?? null],
  )
  return { period: key, status: "Open" as const }
}
