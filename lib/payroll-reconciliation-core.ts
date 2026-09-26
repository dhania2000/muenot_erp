// SPEC 44 (#203) — Payroll reconciliation: attendance (hr_attendance) ×
// approved timesheets (operations_timesheets) → payable hours, overtime, gross,
// tax withholding and net per employee per period. Pure — no DB access — so the
// route, the persisted run and the tests all share one calculation.

import { OVERTIME_MULTIPLIER, STANDARD_DAILY_HOURS } from "@/lib/operations-time-tracking"

export type AttendanceDay = {
  employee_id: string
  employee_name?: string
  work_date: string
  working_hours: number
  status: string
}

export type TimesheetDay = {
  employee_id: string
  work_date: string
  hours: number
}

export type TaxSlab = { upTo: number | null; rate: number }

/** Annual progressive slabs (India new regime FY 2025-26 style) — overridable per run. */
export const DEFAULT_TAX_SLABS: TaxSlab[] = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 5 },
  { upTo: 1200000, rate: 10 },
  { upTo: 1600000, rate: 15 },
  { upTo: 2000000, rate: 20 },
  { upTo: 2400000, rate: 25 },
  { upTo: null, rate: 30 },
]

export const PAID_ABSENCE_STATUSES = new Set(["leave", "holiday", "weekly off", "paid leave"])

export type ReconFlag = "timesheet_without_attendance" | "attendance_without_timesheet" | "hours_mismatch"

export type ReconDayIssue = {
  work_date: string
  flag: ReconFlag
  attendanceHours: number
  timesheetHours: number
}

export type PayrollLine = {
  employee_id: string
  employee_name: string
  period: string
  hourlyRate: number
  attendanceHours: number
  timesheetHours: number
  payableHours: number
  regularHours: number
  overtimeHours: number
  paidAbsenceDays: number
  gross: number
  taxWithheld: number
  net: number
  issues: ReconDayIssue[]
  reconciled: boolean
}

export type PayrollSummary = {
  period: string
  employeeCount: number
  gross: number
  taxWithheld: number
  net: number
  unreconciledCount: number
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function isValidPeriod(period: unknown): period is string {
  return typeof period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
}

export function validateTaxSlabs(slabs: unknown): TaxSlab[] {
  if (!Array.isArray(slabs) || slabs.length === 0) throw new Error("Tax slabs must be a non-empty array.")
  let prev = 0
  return slabs.map((raw, i) => {
    const s = raw as TaxSlab
    const rate = Number(s?.rate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error(`Tax slab ${i + 1} has an invalid rate.`)
    const last = i === slabs.length - 1
    if (s.upTo == null) {
      if (!last) throw new Error("Only the final tax slab may be open-ended.")
      return { upTo: null, rate }
    }
    const upTo = Number(s.upTo)
    if (!Number.isFinite(upTo) || upTo <= prev) throw new Error("Tax slab limits must be strictly increasing.")
    prev = upTo
    return { upTo, rate }
  })
}

/** Progressive tax on an annual amount. */
export function annualTax(annualIncome: number, slabs: TaxSlab[] = DEFAULT_TAX_SLABS): number {
  let tax = 0
  let lower = 0
  for (const slab of slabs) {
    const upper = slab.upTo ?? Infinity
    if (annualIncome <= lower) break
    const taxable = Math.min(annualIncome, upper) - lower
    tax += (taxable * slab.rate) / 100
    lower = upper
  }
  return round2(tax)
}

/** Monthly withholding: annualise the month's gross, tax it, and take 1/12. */
export function monthlyWithholding(monthlyGross: number, slabs: TaxSlab[] = DEFAULT_TAX_SLABS): number {
  if (monthlyGross <= 0) return 0
  return round2(annualTax(monthlyGross * 12, slabs) / 12)
}

export type ReconcileOptions = {
  period: string
  rateOf: (employeeId: string) => number
  slabs?: TaxSlab[]
  /** Absolute hour tolerance per day before a mismatch is flagged. */
  toleranceHours?: number
}

/**
 * Reconcile attendance and approved timesheets for ONE period. Rows dated in a
 * different period are ignored (cross-period entries belong to their own run).
 * Payable hours per day = min(attendance, timesheet) — neither source alone can
 * inflate pay. Paid absences (leave/holiday) pay a standard day.
 */
export function reconcilePayroll(
  attendance: AttendanceDay[],
  timesheets: TimesheetDay[],
  opts: ReconcileOptions,
): { lines: PayrollLine[]; summary: PayrollSummary } {
  if (!isValidPeriod(opts.period)) throw new Error("Period must be YYYY-MM.")
  const tolerance = opts.toleranceHours ?? 0.5
  const slabs = opts.slabs ?? DEFAULT_TAX_SLABS
  const inPeriod = (d: string) => String(d).slice(0, 7) === opts.period

  type Day = { att: number; ts: number; hasAtt: boolean; hasTs: boolean; paidAbsence: boolean }
  const byEmp = new Map<string, { name: string; days: Map<string, Day> }>()
  const dayOf = (emp: string, date: string) => {
    const e = byEmp.get(emp) ?? { name: "", days: new Map<string, Day>() }
    byEmp.set(emp, e)
    const d = e.days.get(date) ?? { att: 0, ts: 0, hasAtt: false, hasTs: false, paidAbsence: false }
    e.days.set(date, d)
    return { e, d }
  }

  for (const a of attendance) {
    const date = String(a.work_date).slice(0, 10)
    if (!inPeriod(date) || !a.employee_id) continue
    const { e, d } = dayOf(String(a.employee_id), date)
    if (a.employee_name) e.name = a.employee_name
    if (PAID_ABSENCE_STATUSES.has(String(a.status).toLowerCase())) d.paidAbsence = true
    else if (String(a.status).toLowerCase() !== "absent") {
      d.hasAtt = true
      d.att = round2(d.att + Math.max(0, Number(a.working_hours) || 0))
    }
  }
  for (const t of timesheets) {
    const date = String(t.work_date).slice(0, 10)
    if (!inPeriod(date) || !t.employee_id) continue
    const { d } = dayOf(String(t.employee_id), date)
    d.hasTs = true
    d.ts = round2(d.ts + Math.max(0, Number(t.hours) || 0))
  }

  const lines: PayrollLine[] = []
  for (const [employeeId, { name, days }] of byEmp) {
    const hourlyRate = round2(Math.max(0, opts.rateOf(employeeId) || 0))
    let attendanceHours = 0
    let timesheetHours = 0
    let regular = 0
    let overtime = 0
    let paidAbsenceDays = 0
    const issues: ReconDayIssue[] = []

    for (const [date, d] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
      attendanceHours = round2(attendanceHours + d.att)
      timesheetHours = round2(timesheetHours + d.ts)
      if (d.paidAbsence && !d.hasAtt && !d.hasTs) {
        paidAbsenceDays += 1
        regular = round2(regular + STANDARD_DAILY_HOURS)
        continue
      }
      let flag: ReconFlag | null = null
      if (d.hasTs && !d.hasAtt) flag = "timesheet_without_attendance"
      else if (d.hasAtt && !d.hasTs) flag = "attendance_without_timesheet"
      else if (Math.abs(d.att - d.ts) > tolerance) flag = "hours_mismatch"
      if (flag) issues.push({ work_date: date, flag, attendanceHours: d.att, timesheetHours: d.ts })

      const payable = d.hasAtt && d.hasTs ? Math.min(d.att, d.ts) : 0
      regular = round2(regular + Math.min(payable, STANDARD_DAILY_HOURS))
      overtime = round2(overtime + Math.max(0, payable - STANDARD_DAILY_HOURS))
    }

    const gross = round2(regular * hourlyRate + overtime * hourlyRate * OVERTIME_MULTIPLIER)
    const taxWithheld = monthlyWithholding(gross, slabs)
    lines.push({
      employee_id: employeeId,
      employee_name: name || employeeId,
      period: opts.period,
      hourlyRate,
      attendanceHours,
      timesheetHours,
      payableHours: round2(regular + overtime),
      regularHours: regular,
      overtimeHours: overtime,
      paidAbsenceDays,
      gross,
      taxWithheld,
      net: round2(gross - taxWithheld),
      issues,
      reconciled: issues.length === 0,
    })
  }
  lines.sort((a, b) => a.employee_name.localeCompare(b.employee_name))

  return {
    lines,
    summary: {
      period: opts.period,
      employeeCount: lines.length,
      gross: round2(lines.reduce((s, l) => s + l.gross, 0)),
      taxWithheld: round2(lines.reduce((s, l) => s + l.taxWithheld, 0)),
      net: round2(lines.reduce((s, l) => s + l.net, 0)),
      unreconciledCount: lines.filter((l) => !l.reconciled).length,
    },
  }
}
