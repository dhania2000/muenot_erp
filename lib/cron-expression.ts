/**
 * Pure five-field cron parser shared by the platform cron registry
 * (lib/cron-jobs.ts) and tenant scheduled jobs (lib/tenant-jobs/model.ts).
 * Dependency-free so it runs on the server, in client previews and in Vitest.
 *
 * Supported syntax per field: `*`, `N`, `A-B`, `* /S`, `A-B/S` and comma lists.
 * Weekday is 0-6 (Sunday = 0). Names (JAN, MON) and `?`/`L`/`W` are rejected.
 */

export const CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const

export function parseCronPart(part: string, min: number, max: number): number[] | null {
  const [base, stepRaw, extra] = part.split("/")
  if (extra !== undefined) return null
  const step = stepRaw == null ? 1 : Number(stepRaw)
  if (!Number.isInteger(step) || step < 1) return null
  if (base === "*") return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step)
  if (!/^\d+(-\d+)?$/.test(base)) return null
  const range = base.split("-")
  const start = Number(range[0])
  const end = range.length === 2 ? Number(range[1]) : start
  if (start < min || end > max || start > end) return null
  const out: number[] = []
  for (let value = start; value <= end; value += step) out.push(value)
  return out
}

export function expandCronField(field: string, min: number, max: number): number[] | null {
  if (!field) return null
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const parsed = parseCronPart(part, min, max)
    if (!parsed) return null
    for (const value of parsed) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

export function validateCronExpression(expression: string): { ok: true } | { ok: false; error: string } {
  if (typeof expression !== "string" || expression.length > 120) return { ok: false, error: "Cron expression is too long" }
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return { ok: false, error: "Cron expression must contain exactly 5 fields" }
  for (let i = 0; i < fields.length; i++) {
    if (!expandCronField(fields[i], CRON_FIELD_RANGES[i][0], CRON_FIELD_RANGES[i][1])) {
      return { ok: false, error: `Invalid cron field ${i + 1}` }
    }
  }
  return { ok: true }
}

export type ParsedCron = {
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Vixie semantics: when BOTH day-of-month and weekday are restricted, either may match. */
  dayRestricted: boolean
  weekdayRestricted: boolean
  /** Hour field covers every hour — used for DST fall-back handling. */
  everyHour: boolean
}

export function parseCron(expression: string): ParsedCron | null {
  if (validateCronExpression(expression).ok === false) return null
  const [m, h, dom, mon, dow] = expression.trim().split(/\s+/)
  const minutes = expandCronField(m, 0, 59)!
  const hours = expandCronField(h, 0, 23)!
  return {
    minutes,
    hours,
    days: new Set(expandCronField(dom, 1, 31)!),
    months: new Set(expandCronField(mon, 1, 12)!),
    weekdays: new Set(expandCronField(dow, 0, 6)!),
    dayRestricted: dom !== "*",
    weekdayRestricted: dow !== "*",
    everyHour: hours.length === 24,
  }
}

export function cronCalendarMatches(cron: ParsedCron, month: number, day: number, weekday: number): boolean {
  if (!cron.months.has(month)) return false
  const dayMatch = cron.days.has(day)
  const weekdayMatch = cron.weekdays.has(weekday)
  return cron.dayRestricted && cron.weekdayRestricted ? dayMatch || weekdayMatch : dayMatch && weekdayMatch
}
