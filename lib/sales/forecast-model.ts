/**
 * Pure, client-safe forecast model. Keep this file free of server-only imports
 * (db / auth / node builtins) so both the calculation engine and the UI can
 * share ONE definition of:
 *   - the stage -> probability mapping (centralised, never scattered)
 *   - forecast category rules (Pipeline / Best Case / Commit / Omitted)
 *   - fiscal-quarter maths driven by the configured financial-year start month
 *   - risk scoring
 *
 * The Forecast screen is a reporting/decision layer over real Sales records; it
 * does not own its own probability, quarter, or value fields. Everything here
 * derives from the lead lifecycle + quotation + contract data.
 */

// ---------------------------------------------------------------------------
// Forecast categories
// ---------------------------------------------------------------------------

export const FORECAST_CATEGORIES = ["Commit", "Best Case", "Pipeline", "Omitted"] as const
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number]

/** Where a forecast amount ultimately comes from (commercial lineage anchor). */
export type ForecastSource = "Contract" | "Quotation" | "Lead"

// ---------------------------------------------------------------------------
// Stage -> probability (only used when a lead has no explicit probability).
// Mirrors the health-score ladder in lead-lifecycle.ts so the two stay coherent.
// ---------------------------------------------------------------------------

const STAGE_PROBABILITY: Record<string, number> = {
  New: 10,
  Qualified: 20,
  "Follow Up 1": 20,
  "Follow Up 2": 25,
  "Follow Up 3": 30,
  "Follow Up 4": 35,
  "Follow Up 5": 40,
  "Follow Up 6": 45,
  "Follow Up 7": 50,
  "In Discussion": 45,
  "Proposal Sent": 65,
  Ready: 85,
  Won: 100,
  Lost: 0,
}

/**
 * Resolve the probability for an opportunity. An explicit lead probability
 * always wins; otherwise fall back to the centralised stage ladder. Won/Lost
 * lifecycle states are absolute.
 */
export function resolveProbability(input: {
  stage?: string | null
  leadStatus?: string | null
  probability?: number | null
}): number {
  if (input.leadStatus === "Won") return 100
  if (input.leadStatus === "Lost") return 0
  if (input.probability != null && Number.isFinite(Number(input.probability))) {
    return Math.max(0, Math.min(100, Number(input.probability)))
  }
  const stage = input.stage ?? ""
  if (stage in STAGE_PROBABILITY) return STAGE_PROBABILITY[stage]
  return 10
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

/**
 * Classify an opportunity into a controlled forecast category. `committed` is
 * true when the deal is Won or backed by an active/signed contract — that is
 * the one place CRM "Commit" overlaps commercial reality.
 */
export function classifyCategory(input: {
  eligible: boolean
  committed: boolean
  probability: number
}): ForecastCategory {
  if (!input.eligible) return "Omitted"
  if (input.committed) return "Commit"
  if (input.probability >= 60) return "Best Case"
  if (input.probability >= 10) return "Pipeline"
  return "Omitted"
}

export const CATEGORY_BADGE: Record<ForecastCategory, "default" | "secondary" | "outline" | "destructive"> = {
  Commit: "default",
  "Best Case": "secondary",
  Pipeline: "outline",
  Omitted: "destructive",
}

// ---------------------------------------------------------------------------
// Fiscal quarter maths
// ---------------------------------------------------------------------------

const MONTH_START_INDEX: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }

/** Financial-year start month index (0-11). Defaults to April (Indian FY). */
export function fyStartMonthIndex(startMonthName?: string | null): number {
  if (startMonthName && startMonthName in MONTH_START_INDEX) return MONTH_START_INDEX[startMonthName]
  return 3
}

/** Human label for a financial year given its start calendar year, e.g. "2026-27". */
export function fyLabel(fyStartYear: number, startMonth: number): string {
  if (startMonth === 0) return String(fyStartYear) // calendar-year FY
  return `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`
}

/** Which financial year + quarter (1-4) a date falls into. */
export function fiscalPositionFor(
  date: Date,
  startMonth: number,
): { fyStartYear: number; quarter: number } {
  const m = date.getMonth()
  const y = date.getFullYear()
  const monthsSinceStart = (m - startMonth + 12) % 12
  const quarter = Math.floor(monthsSinceStart / 3) + 1
  const fyStartYear = m >= startMonth ? y : y - 1
  return { fyStartYear, quarter }
}

/** Inclusive [start, end] calendar range for a fiscal quarter (as yyyy-mm-dd). */
export function quarterRange(
  fyStartYear: number,
  quarter: number,
  startMonth: number,
): { start: string; end: string } {
  const startAbs = startMonth + (quarter - 1) * 3
  const start = new Date(fyStartYear, startAbs, 1)
  const end = new Date(fyStartYear, startAbs + 3, 0)
  return { start: toISODate(start), end: toISODate(end) }
}

/** The financial year that contains "today", used as the default view. */
export function currentFyStartYear(startMonth: number, now: Date = new Date()): number {
  return fiscalPositionFor(now, startMonth).fyStartYear
}

function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// ---------------------------------------------------------------------------
// Risk scoring (simple, explainable — no black box)
// ---------------------------------------------------------------------------

export type RiskLevel = "Low" | "Medium" | "High"

export const RISK_BADGE: Record<RiskLevel, "default" | "secondary" | "destructive"> = {
  Low: "default",
  Medium: "secondary",
  High: "destructive",
}

/**
 * Score forecast risk from concrete signals. Returns the level plus the reasons
 * that drove it so the UI can explain "why is this at risk?".
 */
export function scoreRisk(input: {
  committed: boolean
  probability: number
  expectedCloseDate?: string | null
  lastActivityAt?: string | null
  quoteValidUntil?: string | null
  now?: Date
}): { level: RiskLevel; reasons: string[] } {
  if (input.committed) return { level: "Low", reasons: [] }
  const now = input.now ?? new Date()
  const reasons: string[] = []
  let points = 0

  if (input.probability < 30) {
    points += 2
    reasons.push("Low probability")
  } else if (input.probability < 60) {
    points += 1
  }

  if (!input.expectedCloseDate) {
    points += 1
    reasons.push("No expected close date")
  } else {
    const close = new Date(input.expectedCloseDate)
    if (!Number.isNaN(close.getTime()) && close < now) {
      points += 2
      reasons.push("Close date is overdue")
    }
  }

  if (input.lastActivityAt) {
    const last = new Date(input.lastActivityAt)
    const days = (now.getTime() - last.getTime()) / 86_400_000
    if (Number.isFinite(days) && days > 30) {
      points += 1
      reasons.push("No activity in 30+ days")
    }
  }

  if (input.quoteValidUntil) {
    const valid = new Date(input.quoteValidUntil)
    if (!Number.isNaN(valid.getTime()) && valid < now) {
      points += 1
      reasons.push("Quotation expired")
    }
  }

  const level: RiskLevel = points >= 3 ? "High" : points >= 1 ? "Medium" : "Low"
  return { level, reasons }
}

// ---------------------------------------------------------------------------
// Forecast health (per quarter, vs target)
// ---------------------------------------------------------------------------

export type ForecastHealth = "Healthy" | "At Risk" | "Critical" | "No Target"

export const HEALTH_BADGE: Record<ForecastHealth, "default" | "secondary" | "destructive" | "outline"> = {
  Healthy: "default",
  "At Risk": "secondary",
  Critical: "destructive",
  "No Target": "outline",
}

export function forecastHealth(expected: number, target: number): ForecastHealth {
  if (!target || target <= 0) return "No Target"
  const ratio = expected / target
  if (ratio >= 0.9) return "Healthy"
  if (ratio >= 0.7) return "At Risk"
  return "Critical"
}

// ---------------------------------------------------------------------------
// Manual adjustment types
// ---------------------------------------------------------------------------

export const ADJUSTMENT_TYPES = ["Expected", "Best Case", "Worst Case", "Target"] as const
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number]
