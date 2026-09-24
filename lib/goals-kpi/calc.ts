/**
 * SPEC 135 — Goal / KPI Engine · calculation framework (Phase 2).
 * ---------------------------------------------------------------------------
 * Pure, deterministic, dependency-free math for turning a KPI's target/actual
 * into progress, a health band, and weighted roll-up scores. Kept free of any
 * I/O so it can be unit-tested in isolation (see calc.test.ts) and reused on
 * both the server and the client.
 *
 * Progress semantics by direction:
 *   - increase  (higher is better): progress = actual / target
 *   - decrease  (lower is better) : progress = target / actual   (0 actual ⇒ met)
 *   - maintain  (on target)       : progress = 1 - |actual - target| / target
 *
 * All progress values are returned as a percentage. `progressRaw` is unclamped
 * (can exceed 100 for over-performance or go negative for a maintain miss);
 * `progress` is clamped to [0, 100] for display and weighting.
 */

import type { KpiDirection, KpiHealth, KpiGoal, KpiGoalComputed } from "./config"

export type ProgressInput = {
  target: number
  actual: number
  direction: KpiDirection
}

const clampPct = (n: number): number => {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Raw (unclamped) progress percentage for a single KPI. */
export function computeProgressRaw({ target, actual, direction }: ProgressInput): number {
  const t = Number(target)
  const a = Number(actual)
  if (!Number.isFinite(t) || !Number.isFinite(a)) return 0

  switch (direction) {
    case "increase": {
      if (t === 0) return a > 0 ? 100 : 0
      return (a / t) * 100
    }
    case "decrease": {
      // Lower actual is better. Meeting or beating the ceiling is 100%+.
      if (a <= 0) return 100
      if (t <= 0) return 0
      return (t / a) * 100
    }
    case "maintain": {
      if (t === 0) return a === 0 ? 100 : 0
      const deviation = Math.abs(a - t) / Math.abs(t)
      return (1 - deviation) * 100
    }
    default:
      return 0
  }
}

/** Clamped [0,100] progress percentage, rounded to 2 decimals. */
export function computeProgress(input: ProgressInput): number {
  return round2(clampPct(computeProgressRaw(input)))
}

/** Map a clamped progress percentage to a health band. */
export function healthFromProgress(progress: number): KpiHealth {
  if (progress >= 100) return "achieved"
  if (progress >= 70) return "on_track"
  if (progress >= 40) return "at_risk"
  return "behind"
}

/**
 * Weighted score across a set of KPIs: Σ(progressᵢ · weightᵢ) / Σ(weightᵢ).
 * Non-positive weights are ignored. Returns 0 for an empty / zero-weight set.
 */
export function weightedScore(items: Array<{ progress: number; weight: number }>): number {
  let num = 0
  let den = 0
  for (const it of items) {
    const w = Number(it.weight)
    if (!Number.isFinite(w) || w <= 0) continue
    num += clampPct(it.progress) * w
    den += w
  }
  if (den === 0) return 0
  return round2(num / den)
}

/** Enrich a raw KPI row with progress, health and its weighted contribution. */
export function computeKpi(goal: KpiGoal): KpiGoalComputed {
  const progress = computeProgress({
    target: goal.target_value,
    actual: goal.actual_value,
    direction: goal.direction,
  })
  return {
    ...goal,
    progress,
    health: healthFromProgress(progress),
    weightedContribution: round2(progress * (Number(goal.weight) > 0 ? Number(goal.weight) : 0)),
  }
}

export type KpiRollup = {
  count: number
  averageProgress: number
  weightedScore: number
  totalWeight: number
  byHealth: Record<KpiHealth, number>
}

/** Aggregate a set of computed KPIs into summary metrics. */
export function rollup(items: KpiGoalComputed[]): KpiRollup {
  const byHealth: Record<KpiHealth, number> = { achieved: 0, on_track: 0, at_risk: 0, behind: 0 }
  let progressSum = 0
  let totalWeight = 0
  for (const it of items) {
    byHealth[it.health] += 1
    progressSum += it.progress
    const w = Number(it.weight)
    if (Number.isFinite(w) && w > 0) totalWeight += w
  }
  return {
    count: items.length,
    averageProgress: items.length ? round2(progressSum / items.length) : 0,
    weightedScore: weightedScore(items),
    totalWeight: round2(totalWeight),
    byHealth,
  }
}

/** Group computed KPIs by scope, with a per-scope roll-up. */
export function rollupByScope(items: KpiGoalComputed[]): Record<string, KpiRollup> {
  const groups: Record<string, KpiGoalComputed[]> = {}
  for (const it of items) {
    ;(groups[it.scope] ??= []).push(it)
  }
  const out: Record<string, KpiRollup> = {}
  for (const [scope, list] of Object.entries(groups)) out[scope] = rollup(list)
  return out
}
