// Client-safe, pure Shift helpers. No DB / server imports here so both the
// client form (live preview + validation) and the server service
// (lib/hr-shifts.ts) share one source of truth for shift maths and rules.

export const WEEKDAYS = [
  { num: 0, short: "Sun", long: "Sunday" },
  { num: 1, short: "Mon", long: "Monday" },
  { num: 2, short: "Tue", long: "Tuesday" },
  { num: 3, short: "Wed", long: "Wednesday" },
  { num: 4, short: "Thu", long: "Thursday" },
  { num: 5, short: "Fri", long: "Friday" },
  { num: 6, short: "Sat", long: "Saturday" },
] as const

export const OT_ROUNDING_OPTIONS = [0, 15, 30, 60] as const

/** Minutes since midnight for HH:MM[:SS], or null when unparseable. */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const m = String(value).match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** Parse a comma-separated weekday list ("1,2,3") into a sorted unique 0–6 array. */
export function parseDayList(value: string | null | undefined): number[] {
  if (!value) return []
  return Array.from(
    new Set(
      String(value)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    ),
  ).sort((a, b) => a - b)
}

/** Serialize a weekday array back to a stable comma string, or null when empty. */
export function serializeDayList(days: number[]): string | null {
  const clean = Array.from(new Set(days.filter((n) => n >= 0 && n <= 6))).sort((a, b) => a - b)
  return clean.length ? clean.join(",") : null
}

/** Working days -> weekly offs (the 0–6 complement). */
export function weeklyOffsFromWorkingDays(workingDays: number[]): number[] {
  const work = new Set(workingDays)
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !work.has(d))
}

/** Human label for a working-day set, e.g. "Mon–Fri" or "Mon, Wed, Fri". */
export function formatWorkingDays(days: number[]): string {
  const sorted = Array.from(new Set(days)).sort((a, b) => a - b)
  if (sorted.length === 0) return "—"
  if (sorted.length === 7) return "All days"
  // Detect a single contiguous run to render as a range.
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
  const label = (n: number) => WEEKDAYS[n].short
  if (contiguous && sorted.length > 2) return `${label(sorted[0])}–${label(sorted[sorted.length - 1])}`
  return sorted.map(label).join(", ")
}

/** Gross minutes of a shift span, honouring overnight wrap past midnight. */
export function grossMinutes(start: string, end: string, overnight: boolean): number {
  const s = timeToMinutes(start)
  const e = timeToMinutes(end)
  if (s === null || e === null) return 0
  let span = e - s
  if (span <= 0 || overnight) span += 24 * 60
  return Math.max(0, span)
}

/** Net working hours = (gross span − break) / 60, never negative. */
export function computeShiftHours(start: string, end: string, breakMinutes: number, overnight: boolean): number {
  const net = grossMinutes(start, end, overnight) - Math.max(0, breakMinutes || 0)
  return Math.max(0, Number((net / 60).toFixed(2)))
}

/** Round overtime minutes to the configured increment (nearest). 0 = no rounding. */
export function roundToIncrement(minutes: number, increment: number): number {
  if (!increment || increment <= 0) return Math.max(0, Math.round(minutes))
  return Math.max(0, Math.round(minutes / increment) * increment)
}

/** "HH:MM" clock label for the moment overtime begins (shift end + threshold). */
export function overtimeStartLabel(end: string, thresholdMinutes: number, overnight: boolean): string {
  const e = timeToMinutes(end)
  if (e === null) return "—"
  const total = (e + Math.max(0, thresholdMinutes || 0)) % (24 * 60)
  const hh = String(Math.floor(total / 60)).padStart(2, "0")
  const mm = String(total % 60).padStart(2, "0")
  return `${hh}:${mm}`
}

/** Friendly duration from decimal hours, e.g. 8.5 -> "8h 00m". */
export function formatDurationHours(hours: number): string {
  const total = Math.round(Math.max(0, hours) * 60)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`
}

export type ShiftValidationInput = {
  shift_name?: string
  start_time?: string
  end_time?: string
  is_overnight?: boolean
  break_minutes?: number
  grace_minutes?: number
  early_grace_minutes?: number
  overtime_enabled?: boolean
  overtime_threshold_minutes?: number
  overtime_rounding_minutes?: number
  effective_from?: string | null
  effective_until?: string | null
}

/**
 * Validate a shift configuration. Returns a human-readable error string, or
 * null when the configuration is valid. Shared by the form and the API so the
 * rules can never drift apart.
 */
export function validateShiftInput(i: ShiftValidationInput): string | null {
  if (!i.shift_name || !i.shift_name.trim()) return "Shift name is required."

  const s = timeToMinutes(i.start_time)
  const e = timeToMinutes(i.end_time)
  if (s === null) return "A valid start time is required."
  if (e === null) return "A valid end time is required."

  if (!i.is_overnight && s === e) return "Start and end time cannot be identical unless the shift is overnight."
  if (!i.is_overnight && e < s) return "End time is before start time — enable Overnight for shifts that cross midnight."

  const gross = grossMinutes(i.start_time!, i.end_time!, Boolean(i.is_overnight))
  if (gross <= 0) return "Shift duration must be greater than zero."

  const brk = Number(i.break_minutes || 0)
  if (brk < 0) return "Break duration cannot be negative."
  if (brk >= gross) return "Break duration cannot be equal to or longer than the shift duration."

  if (Number(i.grace_minutes || 0) < 0) return "Grace period cannot be negative."
  if (Number(i.early_grace_minutes || 0) < 0) return "Early checkout grace cannot be negative."

  if (i.overtime_enabled) {
    if (Number(i.overtime_threshold_minutes || 0) < 0) return "Overtime threshold cannot be negative."
    const rounding = Number(i.overtime_rounding_minutes || 0)
    if (![0, 15, 30, 60].includes(rounding)) return "Overtime rounding must be 0, 15, 30 or 60 minutes."
  }

  if (i.effective_from && i.effective_until) {
    if (String(i.effective_until) < String(i.effective_from)) return "Effective Until cannot be before Effective From."
  }

  return null
}
