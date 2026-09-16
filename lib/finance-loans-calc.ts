import { num, round2 } from "@/lib/finance-calc"

/**
 * Pure, client-safe loan maths for the Loans & Advances module (Phase 4).
 *
 * A loan / advance carries a principal, an annual interest rate, a tenure (in
 * months) and an installment frequency. From those we derive the EMI, the end
 * date and a full amortisation schedule with a principal / interest split and a
 * running outstanding balance. Two interest methods are supported:
 *   - "Reducing Balance" (default): interest each period is charged on the
 *     outstanding balance, so the principal component grows over time.
 *   - "Flat": interest is charged on the original principal for the full tenure
 *     and spread evenly, so each installment carries the same split.
 *
 * Everything here is deterministic and free of any database or server import so
 * the config's live `compute` mirror and the server engine share one source of
 * truth.
 */

export const LOAN_TYPES = ["Loan", "Employee Advance", "Vendor Advance", "Customer Advance"] as const
export const INSTALLMENT_FREQUENCIES = ["Monthly", "Quarterly", "Half-Yearly", "Yearly"] as const
export const INTEREST_METHODS = ["Reducing Balance", "Flat", "No Interest"] as const

export type LoanScheduleRow = {
  installment_no: number
  due_date: string
  opening_balance: number
  emi: number
  principal_component: number
  interest_component: number
  closing_balance: number
}

/** Months between two installments for a given frequency (defaults to Monthly). */
export function monthsPerInstallment(frequency?: string | null): number {
  switch (String(frequency || "").trim().toLowerCase()) {
    case "quarterly":
      return 3
    case "half-yearly":
    case "half yearly":
    case "semi-annual":
      return 6
    case "yearly":
    case "annually":
    case "annual":
      return 12
    default:
      return 1
  }
}

/** The direction ("given" vs "taken") implied by a loan/advance type. */
export function directionForLoanType(loanType: string | null | undefined, fallback?: string | null): string {
  switch (String(loanType || "").trim()) {
    case "Employee Advance":
    case "Vendor Advance":
      return "Loan / Advance Given"
    case "Customer Advance":
      return "Loan Taken"
    default:
      // A plain "Loan" can be either given or taken — honour the user's choice.
      return fallback && String(fallback).trim() ? String(fallback) : "Loan / Advance Given"
  }
}

/** Add whole months to an ISO date (YYYY-MM-DD), clamping the day of month. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ""
  const day = d.getUTCDate()
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1))
  // Clamp to the last valid day of the target month (e.g. 31 Jan + 1m -> 28/29 Feb).
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

/** Resolve the number of installments from tenure (months) and frequency. */
export function installmentCount(tenureMonths: number, frequency?: string | null): number {
  const per = monthsPerInstallment(frequency)
  const n = Math.round(num(tenureMonths) / per)
  return Math.max(1, n)
}

/**
 * Build the full amortisation schedule for a loan/advance. Returns an empty plan
 * when the principal or tenure is not set yet, so the form stays quiet until the
 * user has entered enough to compute one.
 */
export function buildLoanSchedule(row: Record<string, any>): {
  emi: number
  endDate: string
  totalInterest: number
  totalPayable: number
  installments: number
  rows: LoanScheduleRow[]
} {
  const principal = round2(num(row.principal))
  const tenureMonths = Math.round(num(row.tenure_months))
  const startDate = String(row.disbursement_date || row.start_date || "").slice(0, 10)
  const per = monthsPerInstallment(row.installment_frequency)
  const method = String(row.interest_method || "Reducing Balance").trim()
  const annualRate = method === "No Interest" ? 0 : num(row.interest_rate)

  const empty = { emi: 0, endDate: "", totalInterest: 0, totalPayable: principal, installments: 0, rows: [] as LoanScheduleRow[] }
  if (principal <= 0 || tenureMonths <= 0 || !startDate) return empty

  const n = installmentCount(tenureMonths, row.installment_frequency)
  const periodicRate = (annualRate / 100) * (per / 12)
  const endDate = addMonths(startDate, tenureMonths)

  const rows: LoanScheduleRow[] = []
  let balance = principal

  if (method === "Flat") {
    const totalInterest = round2(principal * (annualRate / 100) * (tenureMonths / 12))
    const emi = round2((principal + totalInterest) / n)
    const principalPer = round2(principal / n)
    const interestPer = round2(totalInterest / n)
    for (let i = 1; i <= n; i++) {
      const opening = round2(balance)
      let principalComp = principalPer
      let interestComp = interestPer
      if (i === n) {
        // Absorb rounding drift into the final installment.
        principalComp = round2(opening)
        interestComp = round2(totalInterest - interestPer * (n - 1))
      }
      const closing = round2(opening - principalComp)
      rows.push({
        installment_no: i,
        due_date: addMonths(startDate, i * per),
        opening_balance: opening,
        emi: round2(principalComp + interestComp),
        principal_component: principalComp,
        interest_component: interestComp,
        closing_balance: closing < 0 ? 0 : closing,
      })
      balance = closing
    }
    return { emi, endDate, totalInterest, totalPayable: round2(principal + totalInterest), installments: n, rows }
  }

  // Reducing balance (and the zero-interest case, which degenerates to P / n).
  const emi =
    periodicRate > 0
      ? round2((principal * periodicRate * Math.pow(1 + periodicRate, n)) / (Math.pow(1 + periodicRate, n) - 1))
      : round2(principal / n)

  let totalInterest = 0
  for (let i = 1; i <= n; i++) {
    const opening = round2(balance)
    let interestComp = round2(opening * periodicRate)
    let principalComp = round2(emi - interestComp)
    if (i === n) {
      // Final installment clears the balance exactly.
      principalComp = round2(opening)
      interestComp = round2(opening * periodicRate)
    }
    let closing = round2(opening - principalComp)
    if (closing < 0) {
      principalComp = opening
      closing = 0
    }
    totalInterest = round2(totalInterest + interestComp)
    rows.push({
      installment_no: i,
      due_date: addMonths(startDate, i * per),
      opening_balance: opening,
      emi: round2(principalComp + interestComp),
      principal_component: principalComp,
      interest_component: interestComp,
      closing_balance: closing,
    })
    balance = closing
  }

  return { emi, endDate, totalInterest, totalPayable: round2(principal + totalInterest), installments: n, rows }
}

/**
 * Live client mirror + server-derived fields for the Loans & Advances form.
 * Returns the EMI, end date, total interest and the type-implied direction so
 * the user sees them update as they type. The server recomputes the same values
 * authoritatively and (re)builds the persisted schedule on save.
 */
export function computeLoanScheduleFields(v: Record<string, any>): Record<string, any> {
  const plan = buildLoanSchedule(v)
  return {
    emi_amount: plan.emi,
    end_date: plan.endDate || null,
    interest_total: plan.totalInterest,
    total_payable: plan.totalPayable,
    direction: directionForLoanType(v.loan_type, v.direction),
  }
}
