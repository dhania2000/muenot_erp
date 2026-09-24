/**
 * Pure, dependency-free date engine for the Document Expiry service (SPEC 88).
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested against timezone / DST / boundary edge cases (see
 * test/document-expiry.test.ts). No DB, no `server-only`, no `Date.now()` reads
 * unless explicitly passed in — the caller supplies `now` and a business
 * `timeZone`, which is what makes expiry classification stable regardless of
 * where the server happens to run.
 */

export type ExpiryStatus = "None" | "Valid" | "Expiring Soon" | "Expired"

/** Escalation ladder, ordered from least to most severe. */
export type EscalationTier = "none" | "notice" | "warning" | "urgent" | "overdue"

export type RenewalStatus = "Not Applicable" | "Current" | "Renewal Due" | "Renewal Overdue"

/** Default lead time (days) before expiry to start flagging "Expiring Soon". */
export const DEFAULT_EXPIRY_WARN_DAYS = 30

/** "Urgent" escalation kicks in within this many days of expiry. */
export const URGENT_WITHIN_DAYS = 3

/** "Warning" escalation kicks in within this many days of expiry. */
export const WARNING_WITHIN_DAYS = 7

/**
 * Reminder milestones (days before expiry) at which a fresh notification is
 * fired. Kept small and coarse so the notification volume stays sane.
 */
export const REMINDER_OFFSETS = [0, 1, 3, 7, 15, 30] as const

const MS_PER_DAY = 86_400_000
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * Normalize an arbitrary date-ish value (a `YYYY-MM-DD` string, an ISO
 * datetime, or a `Date`) into a canonical `YYYY-MM-DD` calendar date, or null
 * when it cannot be parsed. A `Date` is read in UTC so a value the MySQL driver
 * handed back as `2026-09-30T00:00:00.000Z` maps to `2026-09-30` rather than
 * slipping a day in a negative-offset zone.
 */
export function toISODate(value: string | Date | null | undefined): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, "0")
    const d = String(value.getUTCDate()).padStart(2, "0")
    return `${y}-${m}-${d}`
  }
  const str = String(value).trim()
  const m = ISO_DATE_RE.exec(str)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const parsed = new Date(str)
  if (Number.isNaN(parsed.getTime())) return null
  return toISODate(parsed)
}

/** The calendar date (`YYYY-MM-DD`) of an instant, as observed in `timeZone`. */
export function todayInTimeZone(now: Date = new Date(), timeZone = "UTC"): string {
  try {
    // en-CA formats as YYYY-MM-DD, which we can use verbatim.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    const parts = fmt.format(now)
    return ISO_DATE_RE.exec(parts) ? parts.slice(0, 10) : toISODate(now)!
  } catch {
    // Invalid IANA zone — fall back to UTC rather than throwing into a sweep.
    return toISODate(now)!
  }
}

/** UTC-midnight epoch millis for a `YYYY-MM-DD` string (DST-immune anchor). */
function isoToUtcMidnight(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * Whole calendar days between two `YYYY-MM-DD` dates (`to - from`). Positive
 * when `to` is later. Because both dates are anchored at UTC midnight the result
 * is never off-by-one across DST transitions.
 */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((isoToUtcMidnight(toISO) - isoToUtcMidnight(fromISO)) / MS_PER_DAY)
}

/**
 * Signed whole days from "today" (in `timeZone`) until `expiry`. Negative once
 * the expiry date is in the past. Null when the expiry cannot be parsed.
 */
export function daysUntilExpiry(
  expiry: string | Date | null | undefined,
  opts: { now?: Date; timeZone?: string } = {},
): number | null {
  const iso = toISODate(expiry)
  if (!iso) return null
  const today = todayInTimeZone(opts.now ?? new Date(), opts.timeZone ?? "UTC")
  return daysBetween(today, iso)
}

/** Classify an expiry into a status given a per-document warn window. */
export function classifyStatus(days: number | null, warnDays = DEFAULT_EXPIRY_WARN_DAYS): ExpiryStatus {
  if (days == null) return "None"
  if (days < 0) return "Expired"
  if (days <= Math.max(0, warnDays)) return "Expiring Soon"
  return "Valid"
}

/** Map a day-count to an escalation tier. */
export function escalationTier(days: number | null, warnDays = DEFAULT_EXPIRY_WARN_DAYS): EscalationTier {
  if (days == null) return "none"
  if (days < 0) return "overdue"
  if (days <= URGENT_WITHIN_DAYS) return "urgent"
  if (days <= WARNING_WITHIN_DAYS) return "warning"
  if (days <= Math.max(0, warnDays)) return "notice"
  return "none"
}

/** Human renewal status derived from the expiry classification. */
export function renewalStatus(status: ExpiryStatus): RenewalStatus {
  switch (status) {
    case "Expired":
      return "Renewal Overdue"
    case "Expiring Soon":
      return "Renewal Due"
    case "Valid":
      return "Current"
    default:
      return "Not Applicable"
  }
}

/**
 * The reminder milestone a document currently sits at, or null when it is
 * outside the notification window entirely. Used as part of a dedup key so each
 * threshold notifies exactly once, and so an overdue document re-escalates on a
 * weekly cadence instead of going silent.
 */
export function reminderMilestone(days: number | null, warnDays = DEFAULT_EXPIRY_WARN_DAYS): string | null {
  if (days == null) return null
  if (days < 0) {
    // Re-notify weekly while overdue: week 0 covers days -1..-7, etc.
    const week = Math.floor((-days - 1) / 7)
    return `overdue-w${week}`
  }
  const cap = Math.max(0, warnDays)
  const offsets = REMINDER_OFFSETS.filter((o) => o <= cap)
  if (cap > 0 && !offsets.includes(cap)) offsets.push(cap)
  offsets.sort((a, b) => a - b)
  for (const off of offsets) {
    if (days <= off) return `d${off}`
  }
  return null
}

/** Full classification bundle for a single expiry date. */
export function evaluateExpiry(
  expiry: string | Date | null | undefined,
  opts: { now?: Date; timeZone?: string; warnDays?: number } = {},
): {
  expiryDate: string | null
  daysUntil: number | null
  status: ExpiryStatus
  escalation: EscalationTier
  renewalStatus: RenewalStatus
  milestone: string | null
} {
  const warnDays = opts.warnDays ?? DEFAULT_EXPIRY_WARN_DAYS
  const expiryDate = toISODate(expiry)
  const daysUntil = daysUntilExpiry(expiry, opts)
  const status = classifyStatus(daysUntil, warnDays)
  return {
    expiryDate,
    daysUntil,
    status,
    escalation: escalationTier(daysUntil, warnDays),
    renewalStatus: renewalStatus(status),
    milestone: reminderMilestone(daysUntil, warnDays),
  }
}
