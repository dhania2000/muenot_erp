/**
 * SPEC 135 — Goal / KPI Engine · shared model (Phase 1).
 * ---------------------------------------------------------------------------
 * Framework-agnostic types and constants for the configurable KPI engine.
 * Imported by both server (store / API / calc) and client (dashboard) code, so
 * this file MUST stay free of any server-only dependency.
 *
 * A KPI is defined at one of five SCOPES (individual → company), tracks a
 * TARGET against a running ACTUAL over a PERIOD, carries a WEIGHT used for
 * roll-up scoring, and has a DIRECTION that decides how raw progress is
 * computed (see lib/goals-kpi/calc.ts).
 */

/** Who the KPI measures. */
export const KPI_SCOPES = ["individual", "team", "department", "company", "project"] as const
export type KpiScope = (typeof KPI_SCOPES)[number]

/** Whether a higher, lower, or on-target actual is "good". */
export const KPI_DIRECTIONS = ["increase", "decrease", "maintain"] as const
export type KpiDirection = (typeof KPI_DIRECTIONS)[number]

/** Measurement window. `custom` uses the explicit period_start / period_end. */
export const KPI_PERIODS = ["monthly", "quarterly", "annual", "custom"] as const
export type KpiPeriod = (typeof KPI_PERIODS)[number]

/** Lifecycle of the definition (independent of computed progress health). */
export const KPI_LIFECYCLE = ["active", "archived"] as const
export type KpiLifecycle = (typeof KPI_LIFECYCLE)[number]

/** Computed health band derived from progress %. */
export type KpiHealth = "achieved" | "on_track" | "at_risk" | "behind"

export const SCOPE_LABELS: Record<KpiScope, string> = {
  individual: "Individual",
  team: "Team",
  department: "Department",
  company: "Company",
  project: "Project",
}

export const DIRECTION_LABELS: Record<KpiDirection, string> = {
  increase: "Higher is better",
  decrease: "Lower is better",
  maintain: "On target",
}

export const PERIOD_LABELS: Record<KpiPeriod, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  custom: "Custom",
}

export const HEALTH_LABELS: Record<KpiHealth, string> = {
  achieved: "Achieved",
  on_track: "On track",
  at_risk: "At risk",
  behind: "Behind",
}

/** Company scope has no specific subject; every other scope references one. */
export function scopeRequiresSubject(scope: KpiScope): boolean {
  return scope !== "company"
}

export function isKpiScope(v: unknown): v is KpiScope {
  return typeof v === "string" && (KPI_SCOPES as readonly string[]).includes(v)
}
export function isKpiDirection(v: unknown): v is KpiDirection {
  return typeof v === "string" && (KPI_DIRECTIONS as readonly string[]).includes(v)
}
export function isKpiPeriod(v: unknown): v is KpiPeriod {
  return typeof v === "string" && (KPI_PERIODS as readonly string[]).includes(v)
}

/** A stored KPI definition (raw row shape, dates as ISO strings). */
export type KpiGoal = {
  id: number
  name: string
  description: string | null
  scope: KpiScope
  scope_ref_id: string | null
  scope_ref_label: string | null
  unit: string | null
  direction: KpiDirection
  target_value: number
  actual_value: number
  weight: number
  period_type: KpiPeriod
  period_start: string | null
  period_end: string | null
  lifecycle: KpiLifecycle
  created_at: string
  updated_at: string
}

/** A KPI enriched with computed progress fields (what the dashboard renders). */
export type KpiGoalComputed = KpiGoal & {
  progress: number
  health: KpiHealth
  weightedContribution: number
}

export type KpiCheckin = {
  id: number
  kpi_id: number
  actual_value: number
  note: string | null
  created_by: number | null
  created_at: string
}
