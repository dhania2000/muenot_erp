// Client-safe, pure rotation maths. No DB / server imports so the create wizard
// (live preview) and the server resolver (lib/hr-attendance.ts) + service
// (lib/hr-shift-rotations.ts) share ONE source of truth for cycle resolution.

export type CycleType = "Days" | "Weeks" | "Months"

export const CYCLE_TYPES: CycleType[] = ["Days", "Weeks", "Months"]

/** Singular/plural unit label for a cycle type. */
export function unitLabel(cycleType: CycleType, span = 1): string {
  const base = cycleType === "Days" ? "day" : cycleType === "Weeks" ? "week" : "month"
  return span === 1 ? base : `${base}s`
}

export type PatternStep = {
  shift_id: number
  unit_span: number
  is_weekly_off?: boolean
  shift_name?: string | null
  label?: string | null
}

function parseISO(dateISO: string): { y: number; m: number; d: number } {
  const [y, m, d] = String(dateISO).slice(0, 10).split("-").map(Number)
  return { y, m, d }
}

/** Whole calendar months between two ISO dates (target - anchor), floored. */
export function monthsSince(anchorISO: string, targetISO: string): number {
  const a = parseISO(anchorISO)
  const t = parseISO(targetISO)
  let months = (t.y - a.y) * 12 + (t.m - a.m)
  if (t.d < a.d) months -= 1
  return months
}

/** Whole days between two ISO dates (target - anchor), floored. */
export function daysSince(anchorISO: string, targetISO: string): number {
  const a = new Date(`${String(anchorISO).slice(0, 10)}T00:00:00Z`).getTime()
  const t = new Date(`${String(targetISO).slice(0, 10)}T00:00:00Z`).getTime()
  return Math.floor((t - a) / 86_400_000)
}

/** Convert one pattern step to its span expressed in the resolver's base unit. */
function stepSpanInBaseUnits(cycleType: CycleType, span: number): number {
  const s = Math.max(1, Math.floor(span || 1))
  // Weeks resolve on day granularity (7 days per unit); Days & Months stay 1:1
  // with their own base unit (days and months respectively).
  return cycleType === "Weeks" ? s * 7 : s
}

/** Total length of one full cycle, in the resolver's base unit. */
export function totalCycleSpan(cycleType: CycleType, steps: PatternStep[]): number {
  return steps.reduce((sum, s) => sum + stepSpanInBaseUnits(cycleType, s.unit_span), 0)
}

export type ResolvedStep = { index: number; step: PatternStep }

/**
 * Deterministically resolve which pattern step covers `targetISO`, anchored at
 * `anchorISO`. Days/Weeks use day arithmetic; Months use calendar-month
 * arithmetic so month-length variance never drifts. Returns null before the
 * anchor or when the pattern is empty.
 */
export function resolveStepForDate(
  anchorISO: string,
  cycleType: CycleType,
  steps: PatternStep[],
  targetISO: string,
): ResolvedStep | null {
  if (!steps.length) return null
  const total = totalCycleSpan(cycleType, steps)
  if (total <= 0) return null

  const elapsed = cycleType === "Months" ? monthsSince(anchorISO, targetISO) : daysSince(anchorISO, targetISO)
  if (elapsed < 0) return null

  let offset = ((elapsed % total) + total) % total
  for (let i = 0; i < steps.length; i++) {
    const span = stepSpanInBaseUnits(cycleType, steps[i].unit_span)
    if (offset < span) return { index: i, step: steps[i] }
    offset -= span
  }
  return null
}

/** Add N days to an ISO date, returning ISO. */
export function addDays(dateISO: string, n: number): string {
  const d = new Date(`${String(dateISO).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export type PreviewDay = { date: string; index: number; step: PatternStep | null }

/**
 * Build a day-by-day preview of the rotation for `count` days starting at
 * `startISO`, anchored at `anchorISO`. Used by the wizard preview and the
 * detail calendar so what admins see is exactly what the resolver will apply.
 */
export function buildPreview(
  anchorISO: string,
  cycleType: CycleType,
  steps: PatternStep[],
  startISO: string,
  count: number,
): PreviewDay[] {
  const out: PreviewDay[] = []
  for (let i = 0; i < count; i++) {
    const date = addDays(startISO, i)
    const resolved = resolveStepForDate(anchorISO, cycleType, steps, date)
    out.push({ date, index: resolved?.index ?? -1, step: resolved?.step ?? null })
  }
  return out
}

/** Human summary of a cycle, e.g. "3 steps · 2-week cycle". */
export function describeCycle(cycleType: CycleType, cycleLength: number, steps: PatternStep[]): string {
  const stepWord = steps.length === 1 ? "step" : "steps"
  return `${steps.length} ${stepWord} · ${cycleLength}-${unitLabel(cycleType, cycleLength)} cycle`
}

/** Validate a rotation pattern. Returns an error string or null when valid. */
export function validatePattern(
  cycleType: CycleType,
  cycleLength: number,
  steps: PatternStep[],
): string | null {
  if (!Number.isInteger(cycleLength) || cycleLength < 1) return "Cycle length must be a positive whole number."
  if (!steps.length) return "Add at least one shift step to the rotation pattern."
  for (const [i, s] of steps.entries()) {
    if (!s.is_weekly_off && (!s.shift_id || s.shift_id <= 0)) {
      return `Step ${i + 1}: choose a shift or mark it a weekly off.`
    }
    if (!Number.isInteger(s.unit_span) || s.unit_span < 1) {
      return `Step ${i + 1}: span must be a positive whole number.`
    }
  }
  // The sum of step spans must equal exactly one declared cycle length so the
  // pattern tiles cleanly (§ deterministic rotation).
  const declared = cycleType === "Weeks" ? cycleLength * 7 : cycleLength
  const total = totalCycleSpan(cycleType, steps)
  if (total !== declared) {
    return `Step spans add up to ${total} ${unitLabel(cycleType === "Weeks" ? "Days" : cycleType, total)}, but the cycle is ${declared} ${unitLabel(cycleType === "Weeks" ? "Days" : cycleType, declared)}. Adjust so they match.`
  }
  return null
}
