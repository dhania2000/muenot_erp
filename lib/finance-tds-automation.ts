import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"
import type { TdsDirection } from "@/lib/finance-tds-filing"
import {
  ensureTdsComplianceSchema,
  isDeductorDirection,
  tdsLiability,
  monthsOfQuarter,
  returnDueDate,
  type TdsQuarter,
} from "@/lib/finance-tds-compliance"

/**
 * Phase 31-32 — Automated TDS compliance calendar + reminders.
 *
 * This module DERIVES a compliance calendar from the very same figures the
 * liability / returns engine already computes (deducted vs deposited per month,
 * per-quarter return status) — it never re-scans invoices or re-implements any
 * TDS logic. It then persists a reminder row for each due date as it enters a
 * lead-time window, so the cron sweep is idempotent (a due date fires once per
 * lead window) and the UI has a durable to-do list.
 *
 * The three statutory obligations, all keyed off existing data:
 *   - challan     : monthly TDS deposit due (7th of next month; 30 Apr for Mar)
 *   - return      : quarterly statement (24Q/26Q/26Q…) due date
 *   - certificate : Form 16A (quarterly) / Form 16 (annual) issue due date
 */

const MS_DAY = 86_400_000

export type ObligationKind = "challan" | "return" | "certificate"
export type ObligationSeverity = "done" | "overdue" | "due-soon" | "upcoming"

export type ComplianceObligation = {
  obligation_key: string
  kind: ObligationKind
  direction: TdsDirection
  form_type: string | null
  quarter: TdsQuarter | null
  period: string | null
  financial_year: string
  title: string
  due_date: string
  amount: number
  status: string // engine status (Deposited / Pending / Filed / Not filed …)
  severity: ObligationSeverity
  days_to_due: number
  done: boolean
}

const startOfToday = (ref: Date = new Date()) => {
  const d = new Date(ref)
  d.setHours(0, 0, 0, 0)
  return d
}

function daysBetween(due: string, ref: Date): number {
  const d = startOfToday(new Date(due))
  return Math.round((d.getTime() - startOfToday(ref).getTime()) / MS_DAY)
}

function severityFor(done: boolean, daysToDue: number): ObligationSeverity {
  if (done) return "done"
  if (daysToDue < 0) return "overdue"
  if (daysToDue <= 7) return "due-soon"
  return "upcoming"
}

/** The Form 16 / 16A issue due date: 15 days after the return due date. */
function certificateDueDate(quarter: TdsQuarter, financialYear: string): string {
  const base = new Date(returnDueDate(quarter, financialYear))
  base.setDate(base.getDate() + 15)
  return base.toISOString().slice(0, 10)
}

/**
 * Build the full compliance calendar for a financial year + direction from the
 * existing liability rollup. Receivable TDS (a Form 26AS credit) has no filing
 * obligations, so it returns an empty calendar.
 */
export async function complianceCalendar(
  financialYear: string,
  direction: TdsDirection,
  ref: Date = new Date(),
): Promise<{ financial_year: string; direction: TdsDirection; obligations: ComplianceObligation[] }> {
  await ensureTdsComplianceSchema()
  if (!isDeductorDirection(direction)) {
    return { financial_year: financialYear, direction, obligations: [] }
  }

  const liab = await tdsLiability(financialYear, direction)
  const obligations: ComplianceObligation[] = []

  // Monthly challan deposit obligations (only months that actually deducted TDS).
  for (const row of liab.rows) {
    if (row.deducted <= 0) continue
    const done = row.status === "Deposited"
    const days = daysBetween(row.due_date, ref)
    obligations.push({
      obligation_key: `challan:${direction}:${row.period}`,
      kind: "challan",
      direction,
      form_type: null,
      quarter: row.quarter,
      period: row.period,
      financial_year: financialYear,
      title: `TDS deposit for ${row.period}`,
      due_date: row.due_date,
      amount: row.balance > 0 ? row.balance : row.total_liability,
      status: row.status,
      severity: severityFor(done, days),
      days_to_due: days,
      done,
    })
  }

  // Quarterly return obligations + the certificate that follows each quarter.
  for (const q of liab.quarterly) {
    if (q.tds <= 0) continue
    const filed = ["Filed", "Under Review", "Payment Pending"].includes(q.return_status)
    const rDays = daysBetween(q.return_due_date, ref)
    obligations.push({
      obligation_key: `return:${direction}:${q.quarter}:${financialYear}`,
      kind: "return",
      direction,
      form_type: q.return_form,
      quarter: q.quarter,
      period: null,
      financial_year: financialYear,
      title: `${q.return_form ?? "TDS"} return for ${q.quarter} ${financialYear}`,
      due_date: q.return_due_date,
      amount: q.tds,
      status: q.return_status,
      severity: severityFor(filed, rDays),
      days_to_due: rDays,
      done: filed,
    })

    const certForm = direction === "employee" ? "16" : "16A"
    const certDue = certForm === "16" ? certificateDueDate("Q4", financialYear) : certificateDueDate(q.quarter, financialYear)
    const certDays = daysBetween(certDue, ref)
    // A certificate can only be issued once the quarter's return is filed.
    obligations.push({
      obligation_key: `certificate:${direction}:${certForm}:${q.quarter}:${financialYear}`,
      kind: "certificate",
      direction,
      form_type: certForm,
      quarter: q.quarter,
      period: null,
      financial_year: financialYear,
      title: `Form ${certForm} for ${q.quarter} ${financialYear}`,
      due_date: certDue,
      amount: q.tds,
      status: filed ? "Return filed" : "Awaiting return",
      severity: severityFor(false, certDays),
      days_to_due: certDays,
      done: false,
    })
  }

  obligations.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.kind.localeCompare(b.kind))
  return { financial_year: financialYear, direction, obligations }
}

/** Which lead-time window a due date currently falls in, or null if not yet due for a reminder. */
function offsetLabel(daysToDue: number): string | null {
  if (daysToDue < 0) return "OVERDUE"
  if (daysToDue === 0) return "DUE"
  if (daysToDue <= 3) return "T-3"
  if (daysToDue <= 7) return "T-7"
  return null
}

export type TdsReminder = {
  id: number
  reminder_id: string
  obligation_key: string
  kind: string
  direction: string
  form_type: string | null
  quarter: string | null
  period: string | null
  financial_year: string | null
  due_date: string
  title: string
  amount: number
  severity: string
  status: string
  offset_label: string | null
  note: string | null
  created_at: string | null
}

function mapReminder(r: any): TdsReminder {
  return {
    id: Number(r.id),
    reminder_id: r.reminder_id,
    obligation_key: r.obligation_key,
    kind: r.kind,
    direction: r.direction,
    form_type: r.form_type ?? null,
    quarter: r.quarter ?? null,
    period: r.period ?? null,
    financial_year: r.financial_year ?? null,
    due_date: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : "",
    title: r.title,
    amount: Number(r.amount || 0),
    severity: r.severity,
    status: r.status,
    offset_label: r.offset_label ?? null,
    note: r.note ?? null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  }
}

/** List open (and recently actioned) reminders, newest due first. */
export async function listTdsReminders(opts: { includeDone?: boolean } = {}): Promise<TdsReminder[]> {
  await ensureTdsComplianceSchema()
  const where = opts.includeDone ? "" : "WHERE status IN ('open','acknowledged')"
  const rows = (await query(
    `SELECT * FROM tds_reminders ${where} ORDER BY (status IN ('open','acknowledged')) DESC, due_date ASC, id DESC LIMIT 300`,
  ).catch(() => [])) as any[]
  return rows.map(mapReminder)
}

/**
 * The idempotent reminder sweep (Phase 32). For every direction we deduct in,
 * derive the calendar, and for each obligation that has entered a lead-time
 * window (T-7 / T-3 / DUE / OVERDUE) and is not yet done, insert a reminder.
 * The UNIQUE(obligation_key, offset_label) key means re-running the sweep never
 * duplicates a reminder. When an obligation becomes done, its open reminders are
 * auto-resolved. Returns how many reminders were created/resolved.
 */
export async function runTdsReminderSweep(
  financialYears: string[],
  opts: { actorId?: number | null; ref?: Date } = {},
): Promise<{ created: number; resolved: number; scanned: number }> {
  await ensureTdsComplianceSchema()
  const ref = opts.ref ?? new Date()
  const directions: TdsDirection[] = ["payable", "employee"]
  let created = 0
  let resolved = 0
  let scanned = 0

  for (const fy of financialYears) {
    for (const dir of directions) {
      const { obligations } = await complianceCalendar(fy, dir, ref)
      for (const ob of obligations) {
        scanned += 1

        if (ob.done) {
          // Resolve any outstanding reminders for a completed obligation.
          const res = (await query(
            `UPDATE tds_reminders SET status = 'done' WHERE obligation_key = ? AND status IN ('open','acknowledged')`,
            [ob.obligation_key],
          ).catch(() => null)) as any
          resolved += Number(res?.affectedRows || 0)
          continue
        }

        // Certificates only become actionable once the return is filed.
        if (ob.kind === "certificate" && ob.status !== "Return filed") continue

        const label = offsetLabel(ob.days_to_due)
        if (!label) continue

        const reminderId = await nextRecordId("TRM")
        const result = (await query(
          `INSERT IGNORE INTO tds_reminders
             (reminder_id, obligation_key, kind, direction, form_type, quarter, period, financial_year,
              due_date, title, amount, severity, status, offset_label)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?)`,
          [
            reminderId, ob.obligation_key, ob.kind, ob.direction, ob.form_type, ob.quarter, ob.period,
            ob.financial_year, ob.due_date, ob.title, ob.amount, ob.severity, label,
          ],
        ).catch(() => null)) as any
        if (Number(result?.affectedRows || 0) > 0) created += 1
      }
    }
  }

  if (created > 0 || resolved > 0) {
    await logFinanceEvent({
      entityType: "tds_reminder",
      entityRef: `sweep:${financialYears.join(",")}`,
      type: "updated",
      summary: `TDS reminder sweep: ${created} raised, ${resolved} resolved across ${scanned} obligations`,
      actorId: opts.actorId ?? null,
    }).catch(() => {})
  }
  return { created, resolved, scanned }
}

/** Acknowledge / dismiss / reopen a reminder. */
export async function setReminderStatus(
  reminderId: string,
  target: "open" | "acknowledged" | "done" | "dismissed",
  opts: { actorId?: number | null; note?: string | null } = {},
) {
  await ensureTdsComplianceSchema()
  const res = (await query(
    `UPDATE tds_reminders SET status = ?, note = COALESCE(?, note) WHERE reminder_id = ?`,
    [target, opts.note ?? null, reminderId],
  ).catch(() => null)) as any
  if (!res || Number(res.affectedRows || 0) === 0) throw new Error("Reminder not found.")
  await logFinanceEvent({
    entityType: "tds_reminder",
    entityRef: reminderId,
    type: "updated",
    summary: `Reminder ${reminderId} marked ${target}`,
    actorId: opts.actorId ?? null,
  }).catch(() => {})
  return { reminder_id: reminderId, status: target }
}
