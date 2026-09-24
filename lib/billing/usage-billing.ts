/**
 * Usage-based billing (pure, dependency-free core).
 * ---------------------------------------------------------------------------
 * Spec 5 — Usage-based billing and quotas. Every calculation that turns metered
 * usage into invoice lines lives here as pure, total functions so the tricky
 * cases (late events, duplicate reconciliation, mid-cycle upgrades, zero-usage
 * invoices) can be unit-tested without a database or request context. The
 * DB-backed service in lib/billing/usage-invoicing.ts composes these with
 * persistence, the subscription period, invoice creation and an idempotency
 * ledger.
 *
 * Reconciliation contract:
 *  - One invoice line per metric per billing period. Never two lines for the
 *    same meter in the same period.
 *  - Charge only the OVERAGE above the plan allowance, at the meter's overage
 *    rate.
 *  - Reconciliation is a DELTA against what has already been billed for the
 *    period, so a re-run after late events bills only the new overage and a
 *    re-run with no new usage bills nothing (no double charging).
 */

import { round2 } from "@/lib/billing/billing-math"

/** Non-negative finite number, else 0. */
function nn(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : 0
}

// ── Overage math ────────────────────────────────────────────────────────────

export type MeterOverage = {
  /** Usage above the plan allowance (never negative). */
  overageUnits: number
  /** round2(overageUnits * overageRate). */
  amount: number
}

/**
 * Overage for a single meter: usage above the included allowance, priced at the
 * overage rate. Usage within (or equal to) the allowance produces zero overage.
 */
export function computeMeterOverage(used: number, allowance: number, overageRate: number): MeterOverage {
  const u = nn(used)
  const a = nn(allowance)
  const r = nn(overageRate)
  const overageUnits = Math.max(0, u - a)
  return { overageUnits, amount: round2(overageUnits * r) }
}

/** Fraction of the allowance consumed (0..1+), or null when the allowance is 0/unlimited. */
export function allowanceConsumedPercent(used: number, allowance: number): number | null {
  const a = nn(allowance)
  if (a <= 0) return null
  return (nn(used) / a) * 100
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export type UsageBillingItem = {
  meterKey: string
  /** Human label for the invoice line description. */
  label?: string
  unit?: string
  /** Total usage recorded for the whole period (late events included). */
  used: number
  /** Included units for the plan (>= 0). */
  allowance: number
  /** Price per unit above the allowance (>= 0). */
  overageRate: number
  /**
   * Overage units already invoiced for this period on a prior reconciliation
   * run. Enables late-event delta billing without double charging. Defaults 0.
   */
  alreadyBilledUnits?: number
}

export type UsageBillingLine = {
  meterKey: string
  label: string
  unit: string
  description: string
  /** Overage units billed on THIS run (the delta). Always > 0 for emitted lines. */
  quantity: number
  unitAmount: number
  /** round2(quantity * unitAmount). */
  amount: number
  /** Cumulative overage units for the period (for the ledger). */
  totalOverageUnits: number
}

export type UsageReconciliation = {
  /** One line per metric that has new billable overage this run. */
  lines: UsageBillingLine[]
  /** round2 sum of all line amounts. */
  total: number
}

/**
 * Collapse items to at most one per meter (summing usage, taking the max of the
 * other fields) so a caller can never accidentally produce two lines for the
 * same metric.
 */
function dedupeByMeter(items: UsageBillingItem[]): UsageBillingItem[] {
  const byKey = new Map<string, UsageBillingItem>()
  for (const it of items) {
    const prev = byKey.get(it.meterKey)
    if (!prev) {
      byKey.set(it.meterKey, { ...it })
      continue
    }
    byKey.set(it.meterKey, {
      ...prev,
      used: nn(prev.used) + nn(it.used),
      allowance: Math.max(nn(prev.allowance), nn(it.allowance)),
      overageRate: Math.max(nn(prev.overageRate), nn(it.overageRate)),
      alreadyBilledUnits: nn(prev.alreadyBilledUnits) + nn(it.alreadyBilledUnits),
    })
  }
  return [...byKey.values()]
}

function describe(item: UsageBillingItem, deltaUnits: number): string {
  const label = item.label ?? item.meterKey
  const unit = item.unit ?? "units"
  const included = nn(item.allowance)
  return `${label} overage — ${deltaUnits} ${unit} over ${included} included @ ${nn(item.overageRate)}/${unit}`
}

/**
 * Reconcile a period's usage into invoice lines. For each metric it computes the
 * cumulative overage, subtracts what was already billed for the period, and
 * emits a line for the positive delta only. Zero-usage, within-allowance,
 * zero-rate and fully-billed metrics emit no line — so a zero-usage period
 * produces an empty result and re-running after nothing changed is a no-op.
 */
export function reconcileUsageLines(items: UsageBillingItem[]): UsageReconciliation {
  const lines: UsageBillingLine[] = []
  for (const item of dedupeByMeter(items)) {
    const rate = nn(item.overageRate)
    const { overageUnits } = computeMeterOverage(item.used, item.allowance, item.overageRate)
    const alreadyBilled = Math.max(0, nn(item.alreadyBilledUnits))
    const deltaUnits = Math.max(0, overageUnits - alreadyBilled)
    if (deltaUnits <= 0 || rate <= 0) continue
    const amount = round2(deltaUnits * rate)
    if (amount <= 0) continue
    lines.push({
      meterKey: item.meterKey,
      label: item.label ?? item.meterKey,
      unit: item.unit ?? "units",
      description: describe(item, deltaUnits),
      quantity: deltaUnits,
      unitAmount: rate,
      amount,
      totalOverageUnits: overageUnits,
    })
  }
  const total = round2(lines.reduce((s, l) => s + l.amount, 0))
  return { lines, total }
}
