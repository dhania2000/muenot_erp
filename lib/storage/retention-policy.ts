/**
 * SPEC 36 — Configurable storage retention (pure).
 * ---------------------------------------------------------------------------
 * SPEC 32 gave every stored file a fixed-preset retention policy baked in at
 * upload time. SPEC 36 makes retention CONFIGURABLE per tenant: a tenant sets a
 * default rule, overrides it per module, puts individual files on legal hold,
 * and can manually override a single file's expiry — and an automatic cleanup
 * job purges whatever has aged out (never touching anything under legal hold).
 *
 * This module is the pure, DB-free core of that model so the arithmetic and the
 * resolution precedence can be unit-tested in isolation and shared with the
 * settings UI. It never imports `server-only`, Node, or the DB.
 *
 * A retention RULE is one of:
 *   - permanent            → keep forever, never auto-purge (expiry = null).
 *   - duration(N, unit)    → keep for N days / months / years, then eligible.
 *
 * Resolution precedence for a given file (highest wins):
 *   1. Legal hold                         → never delete (handled at DB layer).
 *   2. Manual per-file override           → the file's own expiry is authoritative.
 *   3. Module-specific rule (if any)      → module override of the tenant default.
 *   4. Tenant default rule                → the fallback for everything else.
 */

export type RetentionMode = "permanent" | "duration"
export type RetentionUnit = "days" | "months" | "years"

export type RetentionRule = {
  mode: RetentionMode
  /** Whole number of units to keep for; ignored when mode is "permanent". */
  amount: number
  unit: RetentionUnit
}

export const RETENTION_UNIT_OPTIONS: { value: RetentionUnit; label: string }[] = [
  { value: "days", label: "Days" },
  { value: "months", label: "Months" },
  { value: "years", label: "Years" },
]

const UNITS = new Set<string>(RETENTION_UNIT_OPTIONS.map((o) => o.value))
const MODES = new Set<string>(["permanent", "duration"])

/** Guardrails so a fat-fingered value can't create a nonsensical rule. */
export const MIN_RETENTION_AMOUNT = 1
export const MAX_RETENTION_AMOUNT = 3650 // 10y in days; also caps months/years inputs

/**
 * The safe default: keep for 7 years (the common statutory floor for
 * tax/audit records), matching the SPEC 32 `default` preset. A tenant can lower
 * or raise this, or switch to permanent.
 */
export const DEFAULT_RETENTION_RULE: RetentionRule = { mode: "duration", amount: 7, unit: "years" }

export function isRetentionMode(value: unknown): value is RetentionMode {
  return typeof value === "string" && MODES.has(value)
}

export function isRetentionUnit(value: unknown): value is RetentionUnit {
  return typeof value === "string" && UNITS.has(value)
}

/** Clamp an amount into the allowed whole-number range. */
export function normalizeAmount(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return MIN_RETENTION_AMOUNT
  return Math.min(MAX_RETENTION_AMOUNT, Math.max(MIN_RETENTION_AMOUNT, n))
}

/**
 * Coerce arbitrary input into a valid rule. A "permanent" rule keeps a nominal
 * amount/unit so the UI has something to show if the user toggles back.
 */
export function normalizeRetentionRule(input: unknown): RetentionRule {
  const obj = (input ?? {}) as Partial<RetentionRule>
  const mode: RetentionMode = isRetentionMode(obj.mode) ? obj.mode : DEFAULT_RETENTION_RULE.mode
  const unit: RetentionUnit = isRetentionUnit(obj.unit) ? obj.unit : DEFAULT_RETENTION_RULE.unit
  if (mode === "permanent") {
    return { mode, amount: normalizeAmount(obj.amount ?? DEFAULT_RETENTION_RULE.amount), unit }
  }
  return { mode: "duration", amount: normalizeAmount(obj.amount), unit }
}

/**
 * Add a whole number of days/months/years to a date using CALENDAR arithmetic
 * (so "1 month" lands on the same day next month, "1 year" respects leap
 * years). Returns a new Date; never mutates the input.
 */
export function addDuration(from: Date, amount: number, unit: RetentionUnit): Date {
  const base = from instanceof Date && !Number.isNaN(from.getTime()) ? from : new Date()
  const d = new Date(base.getTime())
  const n = Math.max(0, Math.floor(amount))
  if (unit === "days") {
    d.setUTCDate(d.getUTCDate() + n)
  } else if (unit === "months") {
    d.setUTCMonth(d.getUTCMonth() + n)
  } else {
    d.setUTCFullYear(d.getUTCFullYear() + n)
  }
  return d
}

/**
 * Compute the concrete expiry `Date` for a rule anchored at `from`, or null for
 * a permanent rule (never expires).
 */
export function computeExpiry(rule: RetentionRule, from: Date = new Date()): Date | null {
  const normalized = normalizeRetentionRule(rule)
  if (normalized.mode === "permanent") return null
  return addDuration(from, normalized.amount, normalized.unit)
}

/** True when `expiresAt` is on or before `now` (inclusive) — eligible for purge. */
export function isExpired(expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= now.getTime()
}

/**
 * Decide whether a file should be purged by the automatic cleanup. This is the
 * single source of truth for the "never delete under legal hold" rule and the
 * override precedence, kept pure so it can be exhaustively tested.
 */
export function shouldPurge(
  file: { legalHold: boolean; expiresAt: string | Date | null | undefined },
  now: Date = new Date(),
): boolean {
  if (file.legalHold) return false
  return isExpired(file.expiresAt, now)
}

/** Human-readable description of a rule for settings/audit surfaces. */
export function describeRetentionRule(rule: RetentionRule): string {
  const r = normalizeRetentionRule(rule)
  if (r.mode === "permanent") return "Permanent (never auto-deleted)"
  const unit = r.amount === 1 ? r.unit.replace(/s$/, "") : r.unit
  return `${r.amount} ${unit}`
}

/** Resolve the effective rule for a module given the tenant default + overrides. */
export function resolveRule(
  defaultRule: RetentionRule,
  moduleRule: RetentionRule | null | undefined,
): RetentionRule {
  return moduleRule ? normalizeRetentionRule(moduleRule) : normalizeRetentionRule(defaultRule)
}
