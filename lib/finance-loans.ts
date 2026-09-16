import "server-only"
import { query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { ensureLoansAdvancesColumns } from "@/lib/finance-ensure"
import { buildLoanSchedule } from "@/lib/finance-loans-calc"

/**
 * Server-side engine for the Loans & Advances module (Phase 4). Owns the two
 * server-authoritative concerns that must never trust the browser:
 *   1. `augmentLoanAdvance` — fills the type-implied direction, the derived EMI
 *      / end date / total interest, and seeds the outstanding principal &
 *      interest on creation. Statuses that close the loan zero the outstanding.
 *   2. `syncLoanSchedule` — (re)builds the persisted amortisation schedule from
 *      the stored, recomputed row whenever the loan is created or edited.
 *
 * The balanced Journal + General Ledger posting of the principal is handled by
 * the shared register-posting engine (see lib/finance-register-posting), so the
 * Trial Balance, Balance Sheet and ledgers reflect the loan automatically.
 */

const CLOSED_STATUSES = new Set(["Closed", "Written Off", "Cancelled"])

/**
 * Fill server-authoritative loan fields. Runs after the pure `compute` mirror,
 * so its output overrides anything the browser sent.
 */
export async function augmentLoanAdvance(
  merged: Record<string, any>,
  opts: { isCreate: boolean },
): Promise<Record<string, any>> {
  const plan = buildLoanSchedule(merged)
  const out: Record<string, any> = {
    emi_amount: plan.emi,
    end_date: plan.endDate || null,
    interest_total: plan.totalInterest,
    total_payable: plan.totalPayable,
  }

  const status = String(merged.status || "").trim()
  const principal = round2(num(merged.principal))

  if (CLOSED_STATUSES.has(status)) {
    // A settled / written-off loan carries nothing outstanding.
    out.outstanding_principal = 0
    out.outstanding_interest = 0
  } else if (opts.isCreate) {
    // On creation, seed the outstanding balances from the loan terms unless the
    // user explicitly entered them.
    out.outstanding_principal =
      merged.outstanding_principal === undefined || merged.outstanding_principal === "" || num(merged.outstanding_principal) === 0
        ? principal
        : round2(num(merged.outstanding_principal))
    out.outstanding_interest =
      merged.outstanding_interest === undefined || merged.outstanding_interest === "" || num(merged.outstanding_interest) === 0
        ? plan.totalInterest
        : round2(num(merged.outstanding_interest))
  }

  // Keep the legacy single "outstanding_amount" column (principal + interest) in
  // sync so existing KPIs and the Balance Sheet register stay meaningful.
  const op = out.outstanding_principal ?? num(merged.outstanding_principal)
  const oi = out.outstanding_interest ?? num(merged.outstanding_interest)
  out.outstanding_amount = round2(num(op) + num(oi))

  return out
}

/**
 * Rebuild the persisted repayment schedule for a loan from its stored, recomputed
 * row. Idempotent: it clears any prior schedule and regenerates, so an amount /
 * tenure / rate edit always leaves a faithful plan. Failure-tolerant — a schedule
 * error must never block loan CRUD.
 */
export async function syncLoanSchedule(loanId: string): Promise<void> {
  if (!loanId) return
  await ensureLoansAdvancesColumns()
  const [row] = (await query(`SELECT * FROM loans_advances WHERE loan_id = ? LIMIT 1`, [loanId])) as any[]
  if (!row) return

  await query(`DELETE FROM loans_advances_schedule WHERE loan_id = ?`, [loanId])

  const plan = buildLoanSchedule(row)
  if (plan.rows.length === 0) return

  const values: any[] = []
  const placeholders: string[] = []
  for (const r of plan.rows) {
    placeholders.push("(?,?,?,?,?,?,?,?)")
    values.push(
      loanId,
      r.installment_no,
      r.due_date || null,
      r.opening_balance,
      r.emi,
      r.principal_component,
      r.interest_component,
      r.closing_balance,
    )
  }
  await query(
    `INSERT INTO loans_advances_schedule
       (loan_id, installment_no, due_date, opening_balance, emi, principal_component, interest_component, closing_balance)
     VALUES ${placeholders.join(",")}`,
    values,
  )
}

/** Delete a loan's persisted schedule (used when the loan itself is deleted). */
export async function deleteLoanSchedule(loanId: string): Promise<void> {
  if (!loanId) return
  await query(`DELETE FROM loans_advances_schedule WHERE loan_id = ?`, [loanId]).catch(() => {})
}

export type LoanDetail = {
  loan: Record<string, any>
  schedule: Record<string, any>[]
  stats: {
    principal: number
    emi: number
    totalInterest: number
    totalPayable: number
    outstandingPrincipal: number
    outstandingInterest: number
    installments: number
    firstDueDate: string | null
    lastDueDate: string | null
  }
}

/** Load a loan with its full amortisation schedule for the detail view. */
export async function getLoanWithSchedule(loanId: string): Promise<LoanDetail | null> {
  await ensureLoansAdvancesColumns()
  const [loan] = (await query(
    `SELECT x.*, u.name AS created_by_name
       FROM loans_advances x
       LEFT JOIN users u ON u.id = x.created_by
      WHERE x.loan_id = ? LIMIT 1`,
    [loanId],
  )) as any[]
  if (!loan) return null

  const schedule = (await query(
    `SELECT * FROM loans_advances_schedule WHERE loan_id = ? ORDER BY installment_no ASC`,
    [loanId],
  )) as any[]

  const totalInterest = round2(schedule.reduce((s, r) => s + num(r.interest_component), 0))
  const principal = round2(num(loan.principal))

  return {
    loan,
    schedule,
    stats: {
      principal,
      emi: round2(num(loan.emi_amount)),
      totalInterest: totalInterest || round2(num(loan.interest_total)),
      totalPayable: round2(principal + (totalInterest || num(loan.interest_total))),
      outstandingPrincipal: round2(num(loan.outstanding_principal)),
      outstandingInterest: round2(num(loan.outstanding_interest)),
      installments: schedule.length,
      firstDueDate: schedule[0]?.due_date ? String(schedule[0].due_date).slice(0, 10) : null,
      lastDueDate: schedule.length ? String(schedule[schedule.length - 1].due_date).slice(0, 10) : null,
    },
  }
}
