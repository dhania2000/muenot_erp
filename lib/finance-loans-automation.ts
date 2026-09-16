import "server-only"
import { query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { ensureLoansAdvancesColumns } from "@/lib/finance-ensure"
import { emitReminder, financeRecipients, todayIso } from "@/lib/finance-automation-shared"

/**
 * Phase 11 — Loans & Advances installment / interest schedule automation.
 *
 * The amortisation schedule (`loans_advances_schedule`) is already built and
 * persisted per loan (see lib/finance-loans.syncLoanSchedule). This sweep does
 * NOT post cash movements — a repayment is a real bank event a human records —
 * it detects the installments that have fallen due (or are due within a short
 * look-ahead window) on still-open loans and raises a deduped in-app reminder
 * so the installment and its interest component get actioned on time.
 *
 * Duplicate prevention: every reminder is keyed by loan + installment + bucket
 * (`due` vs `overdue`), so re-running on the same day never re-notifies and an
 * installment that slips from due to overdue raises exactly one fresh alert.
 */

const FEATURE = "loans-advances"
const LINK = "/modules/finance/loans-advances"
const OPEN_STATUSES = ["Active", "Disbursed", "Partially Repaid", "Open"]
const LOOK_AHEAD_DAYS = 7

export type LoanReminderResult = {
  ran_at: string
  as_of: string
  due: number
  overdue: number
  notifications: number
}

function fmt(n: number): string {
  return round2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export async function runLoanScheduleReminders(asOfInput?: string | null): Promise<LoanReminderResult> {
  await ensureLoansAdvancesColumns()
  const asOf = (asOfInput || todayIso()).slice(0, 10)

  // Due-or-upcoming installments on loans that are still open. A schedule row is
  // considered outstanding while its status is not a settled marker.
  const rows = (await query(
    `SELECT s.loan_id, s.installment_no, s.due_date, s.emi,
            s.principal_component, s.interest_component,
            l.party_name, l.loan_type, l.status AS loan_status
       FROM loans_advances_schedule s
       JOIN loans_advances l ON l.loan_id = s.loan_id
      WHERE (s.status IS NULL OR s.status NOT IN ('Paid','Settled','Cancelled'))
        AND s.due_date IS NOT NULL
        AND s.due_date <= DATE_ADD(?, INTERVAL ? DAY)
        AND l.status IN (${OPEN_STATUSES.map(() => "?").join(",")})
      ORDER BY s.due_date ASC, s.loan_id ASC, s.installment_no ASC`,
    [asOf, LOOK_AHEAD_DAYS, ...OPEN_STATUSES],
  ).catch(() => [])) as any[]

  const recipients = rows.length ? await financeRecipients(FEATURE) : []

  let due = 0
  let overdue = 0
  let notifications = 0

  for (const r of rows) {
    const dueDate = String(r.due_date).slice(0, 10)
    const isOverdue = dueDate < asOf
    const bucket = isOverdue ? "overdue" : "due"
    if (isOverdue) overdue += 1
    else due += 1

    const party = r.party_name ? ` — ${r.party_name}` : ""
    const emi = fmt(num(r.emi))
    const interest = fmt(num(r.interest_component))
    const title = isOverdue
      ? `Loan installment overdue: ${r.loan_id}`
      : `Loan installment due: ${r.loan_id}`
    const body = `Installment #${r.installment_no}${party} of ${emi} (interest ${interest}) ${
      isOverdue ? "was due" : "is due"
    } on ${dueDate}.`

    notifications += await emitReminder(
      {
        key: `loan:${r.loan_id}:${r.installment_no}:${bucket}`,
        type: "finance-loan",
        title,
        body,
        link: LINK,
        entityType: "loans_advances",
        entityId: String(r.loan_id),
      },
      recipients,
    )
  }

  return { ran_at: new Date().toISOString(), as_of: asOf, due, overdue, notifications }
}
