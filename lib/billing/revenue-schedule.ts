import { round2 } from "@/lib/billing/billing-math"

/**
 * Revenue-recognition schedule builder (pure, dependency-free).
 * ---------------------------------------------------------------------------
 * Prepaid subscription revenue (monthly, yearly, multi-year) is collected up
 * front but earned over the service period. This builds the straight-line
 * schedule that spreads a prepaid amount evenly across its service months so
 * the platform can recognize revenue month by month (ASC 606 / Ind AS 115
 * ratable recognition).
 *
 * Cent-exactness: each month gets an equal cent-rounded share and the final
 * month absorbs the rounding remainder, so the schedule always re-sums to the
 * exact prepaid amount — no revenue is created or lost to rounding.
 */

export type RecognitionPeriod = {
  /** 1-based index within the schedule. */
  index: number
  /** First day of the service month, YYYY-MM-DD. */
  periodStart: string
  /** Last day of the service month, YYYY-MM-DD. */
  periodEnd: string
  /** YYYY-MM tag for the month the revenue is earned in. */
  periodMonth: string
  amount: number
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Add `months` whole calendar months to the first-of-month of `dateStr`. */
function addMonths(dateStr: string, months: number): { year: number; month: number } {
  const d = String(dateStr).slice(0, 10)
  const year = Number(d.slice(0, 4))
  const month = Number(d.slice(5, 7)) // 1-based
  const total = (year * 12 + (month - 1)) + months
  return { year: Math.floor(total / 12), month: (total % 12) + 1 }
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whole calendar months spanned by a subscription period, clamped to >= 1. */
export function monthsBetween(startStr: string, endStr: string): number {
  const s = String(startStr).slice(0, 10)
  const e = String(endStr).slice(0, 10)
  if (!s || !e) return 1
  const sy = Number(s.slice(0, 4))
  const sm = Number(s.slice(5, 7))
  const ey = Number(e.slice(0, 4))
  const em = Number(e.slice(5, 7))
  const diff = (ey * 12 + (em - 1)) - (sy * 12 + (sm - 1))
  return diff >= 1 ? diff : 1
}

/**
 * Build the straight-line recognition schedule for a prepaid amount starting at
 * `startDate` across `months` service months. Each month is anchored to the
 * calendar month of the start date; the day-of-month of the start date is kept
 * for `periodStart` where the calendar allows.
 */
export function buildRecognitionSchedule(input: {
  amount: number
  startDate: string
  months: number
}): RecognitionPeriod[] {
  const amount = round2(Math.abs(Number(input.amount) || 0))
  const months = Math.max(1, Math.floor(Number(input.months) || 1))
  if (amount === 0) return []

  const startDay = Number(String(input.startDate).slice(8, 10)) || 1

  // Equal share for every month except the last, which absorbs the remainder.
  const per = round2(amount / months)
  const periods: RecognitionPeriod[] = []
  let allocated = 0
  for (let i = 0; i < months; i++) {
    const { year, month } = addMonths(input.startDate, i)
    const dim = lastDayOfMonth(year, month)
    const day = Math.min(startDay, dim)
    const periodStart = `${year}-${pad(month)}-${pad(day)}`
    const endInfo = addMonths(input.startDate, i + 1)
    const endDim = lastDayOfMonth(endInfo.year, endInfo.month)
    const endDay = Math.min(startDay, endDim)
    // period end = day before the next period's start (exclusive-end style).
    const endDate = new Date(Date.UTC(endInfo.year, endInfo.month - 1, endDay))
    endDate.setUTCDate(endDate.getUTCDate() - 1)
    const periodEnd = endDate.toISOString().slice(0, 10)

    const isLast = i === months - 1
    const share = isLast ? round2(amount - allocated) : per
    allocated = round2(allocated + share)
    periods.push({
      index: i + 1,
      periodStart,
      periodEnd,
      periodMonth: `${year}-${pad(month)}`,
      amount: share,
    })
  }
  return periods
}
