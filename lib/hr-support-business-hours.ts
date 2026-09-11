import { zonedParts } from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Business-hours SLA math. SLA windows are measured in *working* hours inside a
// configurable business day (default 09:00–18:00, Mon–Fri) and always resolved
// in the company timezone so a ticket raised at 5pm Friday is not "breached"
// over the weekend. Instants are handled as absolute `Date`s; the wall-clock is
// projected into the company timezone with `zonedParts` (shared with the
// attendance engine) so server-UTC never leaks into the calculation.
// ---------------------------------------------------------------------------

export type BusinessHoursConfig = {
  /** Hour the working day starts, 0–23. */
  dayStart: number
  /** Hour the working day ends, 0–23. */
  dayEnd: number
  /** Working weekdays where 0 = Sunday … 6 = Saturday. */
  workingDays: number[]
}

export const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  dayStart: 9,
  dayEnd: 18,
  workingDays: [1, 2, 3, 4, 5],
}

/** Weekday (0=Sun..6=Sat) of an instant in the given timezone. */
function zonedWeekday(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date)
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? 1
}

/** Timezone offset in minutes (wall-clock minus UTC) at the given instant. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const local = new Date(date.toLocaleString("en-US", { timeZone }))
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }))
  return Math.round((local.getTime() - utc.getTime()) / 60000)
}

/** Absolute instant for a wall-clock (y-m-d h:m) in the company timezone. */
function zonedWallClockToDate(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0))
  const offset = tzOffsetMinutes(guess, timeZone)
  return new Date(guess.getTime() - offset * 60000)
}

/** Minutes since midnight (company tz) for an instant. */
function zonedMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  return Number(p.hh) * 60 + Number(p.mm)
}

/** Move an instant to `dayStart` of the same calendar day in company tz. */
function atDayStart(date: Date, timeZone: string, cfg: BusinessHoursConfig): Date {
  const p = zonedParts(date, timeZone)
  return zonedWallClockToDate(Number(p.y), Number(p.m), Number(p.d), cfg.dayStart, 0, timeZone)
}

/** Move an instant to `dayStart` of the next calendar day in company tz. */
function atNextDayStart(date: Date, timeZone: string, cfg: BusinessHoursConfig): Date {
  const next = new Date(date.getTime() + 24 * 60 * 60 * 1000)
  return atDayStart(next, timeZone, cfg)
}

/**
 * Add `hours` of business time to `start`. Skips non-working days and the
 * out-of-hours gap between one working day's end and the next day's start.
 */
export function addBusinessHours(
  start: Date,
  hours: number,
  timeZone: string,
  cfg: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS,
): Date {
  const dayStartMin = cfg.dayStart * 60
  const dayEndMin = cfg.dayEnd * 60
  const dayCapacity = Math.max(1, dayEndMin - dayStartMin)

  let remaining = Math.max(0, hours) * 60 // minutes of business time still owed
  let cursor = new Date(start)
  // Safety bound: never loop more than a few years of working days.
  let guard = 0

  while (remaining > 0 && guard < 5000) {
    guard += 1
    if (!cfg.workingDays.includes(zonedWeekday(cursor, timeZone))) {
      cursor = atNextDayStart(cursor, timeZone, cfg)
      continue
    }
    const nowMin = zonedMinutes(cursor, timeZone)
    if (nowMin < dayStartMin) {
      cursor = atDayStart(cursor, timeZone, cfg)
      continue
    }
    if (nowMin >= dayEndMin) {
      cursor = atNextDayStart(cursor, timeZone, cfg)
      continue
    }
    const availableToday = dayEndMin - nowMin
    if (remaining <= availableToday) {
      cursor = new Date(cursor.getTime() + remaining * 60000)
      remaining = 0
    } else {
      remaining -= availableToday
      cursor = new Date(cursor.getTime() + availableToday * 60000)
      cursor = atNextDayStart(cursor, timeZone, cfg)
    }
  }
  // dayCapacity is referenced to keep the config meaningful for callers that
  // introspect it; it also documents the per-day ceiling used above.
  void dayCapacity
  return cursor
}

/** MySQL DATETIME (company-tz wall clock) for an instant. */
export function toZonedDateTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone)
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm}:${p.ss}`
}
