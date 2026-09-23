/**
 * SPEC 71 — General ERP Data Retention Engine (pure, testable model).
 * ---------------------------------------------------------------------------
 * A retention policy says: for a given MODULE + RECORD TYPE, once records are
 * older than a RETENTION PERIOD, take an ACTION (archive or delete) — unless
 * the policy is paused, under a LEGAL HOLD, or a record matches an EXCEPTION.
 *
 * This module is the DB-free core: period arithmetic, action/status/period
 * normalization, retention-cutoff math, next-run scheduling and the pure
 * exception-matching predicate. It carries no `server-only`, Node or DB import
 * so the arithmetic can be unit-tested in isolation and (type-only) shared with
 * the settings UI — mirroring lib/audit-retention-policy.ts.
 */

// ---------------------------------------------------------------------------
// Period arithmetic
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** Calendar approximations used to convert a value+unit into whole days. */
export const RETENTION_UNIT_DAYS = {
  days: 1,
  months: 30,
  years: 365,
} as const

export type RetentionUnit = keyof typeof RETENTION_UNIT_DAYS

export const RETENTION_UNITS = Object.keys(RETENTION_UNIT_DAYS) as RetentionUnit[]

export const RETENTION_LIMITS = {
  /** A policy may not act on records younger than a single day. */
  MIN_DAYS: 1,
  /** Cap at ~100 years so a fat-fingered value can't create a nonsensical rule. */
  MAX_DAYS: 36_525,
} as const

export function isRetentionUnit(value: unknown): value is RetentionUnit {
  return typeof value === "string" && (RETENTION_UNITS as string[]).includes(value)
}

export function toRetentionUnit(value: unknown): RetentionUnit {
  return isRetentionUnit(value) ? value : "years"
}

/** Clamp an arbitrary day count into the allowed whole-number range. */
export function clampRetentionDays(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return RETENTION_LIMITS.MIN_DAYS
  return Math.min(RETENTION_LIMITS.MAX_DAYS, Math.max(RETENTION_LIMITS.MIN_DAYS, n))
}

/** Convert a value+unit pair into a clamped whole number of days. */
export function toRetentionDays(value: unknown, unit: unknown): number {
  const v = Math.floor(Number(value))
  const u = toRetentionUnit(unit)
  if (!Number.isFinite(v) || v <= 0) return RETENTION_LIMITS.MIN_DAYS
  return clampRetentionDays(v * RETENTION_UNIT_DAYS[u])
}

/**
 * Parse a free-form period string like "7 years", "18 months" or "90 days"
 * into a clamped day count. Returns null when it can't be understood, so a
 * caller can fall back to a structured value + unit.
 */
export function parseRetentionPeriod(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return clampRetentionDays(input)
  if (typeof input !== "string") return null
  const s = input.trim().toLowerCase()
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(day|days|month|months|year|years|d|m|y)?$/)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const rawUnit = m[2] ?? "days"
  const unit: RetentionUnit = rawUnit.startsWith("y")
    ? "years"
    : rawUnit.startsWith("m")
      ? "months"
      : "days"
  return toRetentionDays(value, unit)
}

/** Human-readable description of a retention window for settings/audit surfaces. */
export function describeRetentionDays(days: number): string {
  const d = clampRetentionDays(days)
  if (d % 365 === 0) {
    const years = d / 365
    return `${years} ${years === 1 ? "year" : "years"}`
  }
  if (d % 30 === 0) {
    const months = d / 30
    return `${months} ${months === 1 ? "month" : "months"}`
  }
  return `${d} ${d === 1 ? "day" : "days"}`
}

/**
 * The cutoff timestamp: records created on or before this are older than the
 * retention window and therefore eligible for the policy's action.
 */
export function computeRetentionCutoff(retentionDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - clampRetentionDays(retentionDays) * DAY_MS)
}

/** True when `date` is on or before the cutoff — past the retention window. */
export function isBeyondRetention(
  date: string | Date | null | undefined,
  retentionDays: number,
  now: Date = new Date(),
): boolean {
  if (!date) return false
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= computeRetentionCutoff(retentionDays, now).getTime()
}

// ---------------------------------------------------------------------------
// Actions & status
// ---------------------------------------------------------------------------

export const RETENTION_ACTIONS = ["archive", "delete"] as const
export type RetentionAction = (typeof RETENTION_ACTIONS)[number]

export function isRetentionAction(value: unknown): value is RetentionAction {
  return typeof value === "string" && (RETENTION_ACTIONS as readonly string[]).includes(value)
}

export function toRetentionAction(value: unknown): RetentionAction {
  return isRetentionAction(value) ? value : "archive"
}

export const RETENTION_STATUSES = ["active", "paused"] as const
export type RetentionStatus = (typeof RETENTION_STATUSES)[number]

export function isRetentionStatus(value: unknown): value is RetentionStatus {
  return typeof value === "string" && (RETENTION_STATUSES as readonly string[]).includes(value)
}

export function toRetentionStatus(value: unknown): RetentionStatus {
  return isRetentionStatus(value) ? value : "active"
}

/**
 * The effective run state a policy is in, combining its own status with an
 * active legal hold. This is what drives the UI badge and the engine's
 * decision to skip. `held` always wins so a lawyer's hold can never be
 * overridden by simply un-pausing the policy.
 */
export type RetentionRunState = "active" | "paused" | "held"

export function resolveRunState(status: RetentionStatus, legalHold: boolean): RetentionRunState {
  if (legalHold) return "held"
  return status === "paused" ? "paused" : "active"
}

/** Whether the lifecycle job may act on a policy in this state. */
export function isRunnable(state: RetentionRunState): boolean {
  return state === "active"
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * The next time the daily sweep would act on an active policy: the next 03:00
 * UTC boundary (matching the cron schedule). Paused / held policies have no
 * next run. Pure over `now` so it is deterministic in tests.
 */
export function computeNextRun(state: RetentionRunState, now: Date = new Date()): Date | null {
  if (!isRunnable(state)) return null
  const next = new Date(now)
  next.setUTCHours(3, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

/**
 * An exception carves records out of a policy. Two shapes, combined as OR
 * across all of a policy's exceptions:
 *   - `record`   — a single record id is exempt (e.g. a specific invoice a
 *                  finance lead wants kept).
 *   - `criteria` — every record whose `matchField` equals `matchValue` is
 *                  exempt (e.g. keep all records where region = "EU").
 */
export type RetentionExceptionType = "record" | "criteria"

export function isRetentionExceptionType(value: unknown): value is RetentionExceptionType {
  return value === "record" || value === "criteria"
}

export type RetentionExceptionMatch = {
  type: RetentionExceptionType
  recordRef?: string | null
  matchField?: string | null
  matchValue?: string | null
}

/** A record's fields the exception predicate needs. */
export type ExceptionEvaluable = {
  id: string | number
  fields: Record<string, unknown>
}

/** Does a single exception exempt this record? Pure. */
export function exceptionMatchesRecord(exception: RetentionExceptionMatch, record: ExceptionEvaluable): boolean {
  if (exception.type === "record") {
    if (exception.recordRef == null) return false
    return String(exception.recordRef) === String(record.id)
  }
  // criteria
  if (!exception.matchField) return false
  const actual = record.fields[exception.matchField]
  if (actual == null) return false
  return String(actual) === String(exception.matchValue ?? "")
}

/** True when ANY exception exempts the record. */
export function isRecordExempt(exceptions: RetentionExceptionMatch[], record: ExceptionEvaluable): boolean {
  return exceptions.some((e) => exceptionMatchesRecord(e, record))
}

// ---------------------------------------------------------------------------
// Policy input normalization (shared by the API layer)
// ---------------------------------------------------------------------------

export type NormalizedPolicyInput = {
  module: string
  recordType: string
  retentionDays: number
  action: RetentionAction
  purgeAfterArchive: boolean
  status: RetentionStatus
  catalogKey: string | null
}

/**
 * Coerce arbitrary request input into a valid, safe policy shape. Throws with a
 * user-facing message on the two hard requirements (module + record type). The
 * period accepts either a structured value+unit or a free-form string.
 */
export function normalizePolicyInput(input: {
  module?: unknown
  recordType?: unknown
  retentionValue?: unknown
  retentionUnit?: unknown
  period?: unknown
  action?: unknown
  purgeAfterArchive?: unknown
  status?: unknown
  catalogKey?: unknown
}): NormalizedPolicyInput {
  const module = String(input.module ?? "").trim()
  const recordType = String(input.recordType ?? "").trim()
  if (!module) throw new Error("Module is required")
  if (!recordType) throw new Error("Record type is required")

  let retentionDays: number | null = null
  if (input.retentionValue != null && input.retentionValue !== "") {
    retentionDays = toRetentionDays(input.retentionValue, input.retentionUnit)
  } else if (input.period != null) {
    retentionDays = parseRetentionPeriod(input.period)
  }
  if (retentionDays == null) throw new Error("A valid retention period is required")

  const action = toRetentionAction(input.action)
  const catalogKeyRaw = input.catalogKey == null ? "" : String(input.catalogKey).trim()

  return {
    module: module.slice(0, 96),
    recordType: recordType.slice(0, 160),
    retentionDays: clampRetentionDays(retentionDays),
    action,
    // Purge only means something for archive; a delete already removes the row.
    purgeAfterArchive: action === "archive" ? Boolean(input.purgeAfterArchive) : true,
    status: toRetentionStatus(input.status),
    catalogKey: catalogKeyRaw ? catalogKeyRaw.slice(0, 120) : null,
  }
}
