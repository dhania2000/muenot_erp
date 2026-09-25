import "server-only"
import { tenantSelect } from "@/lib/tenant-scope"
import { round2 } from "@/lib/billing/billing-math"
import { termMonths, isBillingTerm, addDays, type BillingTerm } from "@/lib/billing/subscription-lifecycle"

/**
 * SaaS revenue metrics: MRR, ARR, churn and revenue-by-plan (#240-241).
 * ---------------------------------------------------------------------------
 * All pure calculators are exported and DB-free so they are exhaustively
 * unit-tested; `getSaasMetrics()` composes them over the tenant-scoped
 * subscription and invoice tables.
 *
 * Revenue-by-plan is derived straight from the SaaS invoices (excluding drafts
 * and voids) and reconciled: the sum of the per-plan buckets always equals the
 * total invoiced across the same set, so the report can never silently drop or
 * double-count an invoice against the books.
 */

/** Statuses that represent committed, revenue-bearing subscriptions for MRR. */
export const MRR_STATUSES = new Set(["active", "past_due", "grace"])

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0)

export type SubForMetrics = { amount: number; term: BillingTerm; status: string }

/** Normalize a per-term price to its monthly-recurring equivalent. */
export function monthlyAmount(amount: number, term: BillingTerm): number {
  const m = termMonths(term)
  return m > 0 ? round2(num(amount) / m) : 0
}

/** Monthly Recurring Revenue: sum of monthly-equivalent amounts of live subs. */
export function computeMrr(subs: SubForMetrics[], statuses: Set<string> = MRR_STATUSES): number {
  return round2(
    subs
      .filter((s) => statuses.has(s.status))
      .reduce((sum, s) => sum + monthlyAmount(s.amount, s.term), 0),
  )
}

/** Annual Recurring Revenue derived from MRR. */
export function computeArr(mrr: number): number {
  return round2(num(mrr) * 12)
}

/** Customer/logo churn as a percentage: churned in window / active at window start. */
export function computeChurn(input: { activeAtStart: number; churnedDuring: number }): number {
  const base = num(input.activeAtStart)
  if (base <= 0) return 0
  return round2((num(input.churnedDuring) / base) * 100)
}

export type PlanRevenue = { plan_name: string; invoiced: number; invoices: number }

/**
 * Group invoice totals by plan. The per-plan sum always reconciles to the total
 * invoiced across the input set (same rounding), so callers can assert it.
 */
export function groupRevenueByPlan(
  invoices: Array<{ plan_name?: string | null; total: number }>,
): { plans: PlanRevenue[]; invoicedTotal: number } {
  const map = new Map<string, { invoiced: number; invoices: number }>()
  for (const inv of invoices) {
    const key = (inv.plan_name ?? "").trim() || "Unassigned"
    const cur = map.get(key) ?? { invoiced: 0, invoices: 0 }
    cur.invoiced = round2(cur.invoiced + round2(num(inv.total)))
    cur.invoices += 1
    map.set(key, cur)
  }
  const plans = [...map.entries()]
    .map(([plan_name, v]) => ({ plan_name, invoiced: v.invoiced, invoices: v.invoices }))
    .sort((a, b) => b.invoiced - a.invoiced)
  const invoicedTotal = round2(plans.reduce((s, p) => s + p.invoiced, 0))
  return { plans, invoicedTotal }
}

export type SaasMetricsResult = {
  asOf: string
  mrr: number
  arr: number
  churnRatePct: number
  activeSubscriptions: number
  canceledInWindow: number
  churnWindowStart: string
  revenueByPlan: PlanRevenue[]
  invoicedTotal: number
  reconciled: boolean
}

/**
 * Compute the tenant's SaaS metrics as of `asOf` (default today). Churn is
 * measured over the trailing 30 days. Everything is tenant-scoped through
 * lib/tenant-scope, so it can only ever read the caller tenant's own data.
 */
export async function getSaasMetrics(asOf: string = new Date().toISOString().slice(0, 10)): Promise<SaasMetricsResult> {
  const asOfDate = String(asOf).slice(0, 10)
  const subs = await tenantSelect<any[]>("saas_subscriptions", {
    columns: "id, plan_name, term, amount, status, canceled_at",
  }).catch(() => [] as any[])

  const subMetrics: SubForMetrics[] = subs.map((s) => ({
    amount: num(s.amount),
    term: isBillingTerm(s.term) ? (s.term as BillingTerm) : "monthly",
    status: String(s.status ?? ""),
  }))
  const mrr = computeMrr(subMetrics)
  const arr = computeArr(mrr)
  const activeSubscriptions = subMetrics.filter((s) => MRR_STATUSES.has(s.status)).length

  const windowStart = addDays(asOfDate, -30)
  const canceledInWindow = subs.filter((s) => {
    if (!s.canceled_at) return false
    const d = String(s.canceled_at).slice(0, 10)
    return d >= windowStart && d <= asOfDate
  }).length
  const churnRatePct = computeChurn({ activeAtStart: activeSubscriptions + canceledInWindow, churnedDuring: canceledInWindow })

  const planBySub = new Map<number, string>(subs.map((s) => [Number(s.id), String(s.plan_name ?? "")]))
  const invoices = await tenantSelect<any[]>("billing_invoices", {
    columns: "subscription_id, total, invoice_type, status",
    where: "status NOT IN ('draft','void')",
  }).catch(() => [] as any[])

  const invForPlan = invoices.map((i) => ({
    plan_name: i.subscription_id != null ? planBySub.get(Number(i.subscription_id)) ?? null : null,
    total: num(i.total),
  }))
  const byPlan = groupRevenueByPlan(invForPlan)
  const invoicedTotalAll = round2(invoices.reduce((s, i) => s + num(i.total), 0))

  return {
    asOf: asOfDate,
    mrr,
    arr,
    churnRatePct,
    activeSubscriptions,
    canceledInWindow,
    churnWindowStart: windowStart,
    revenueByPlan: byPlan.plans,
    invoicedTotal: byPlan.invoicedTotal,
    reconciled: byPlan.invoicedTotal === invoicedTotalAll,
  }
}
