import "server-only"
// =============================================================================
// Resource Utilization analytics (SPEC 149) — READ-ONLY derived report.
// -----------------------------------------------------------------------------
// Utilization is computed live from the real source systems and is never stored
// as a duplicate row here:
//   * Actual / Billable hours ← approved operations_timesheets
//   * Available hours         ← Resources master capacity_hours (monthly)
//   * Allocated hours         ← operations_allocations active in the period
//
// The five headline metrics are:
//   Available hours   — planned monthly capacity of the resource
//   Allocated hours   — hours committed to projects via allocations
//   Actual hours      — approved logged effort (hours_worked)
//   Billable hours    — approved billable effort
//   Utilization %     — Actual ÷ Available
//
// Every table/column is probed with tableColumns() first so an install whose
// Operations schema differs degrades to "no data" instead of crashing. Nothing
// here writes to any table — there is a single source of truth (timesheets).
// =============================================================================

import { query, tableColumns } from "@/lib/db"

/** Default monthly capacity assumed when a resource has no capacity_hours set. */
export const DEFAULT_MONTHLY_CAPACITY_HOURS = 160

/** Minimum utilization % considered a healthy/optimal band (below = idle time). */
export const UTILIZATION_TARGET_PERCENT = 75

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
/** Percentage helper — returns 0 (not NaN/Infinity) when the base is zero. */
function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? round2((numerator / denominator) * 100) : 0
}

// ---------------------------------------------------------------------------
// PHASE 1 — Calculations (pure, exported for validation tests)
// ---------------------------------------------------------------------------

export type UtilizationStatus =
  | "No Capacity"
  | "Idle"
  | "Under-utilized"
  | "Optimal"
  | "Over-allocated"

export type UtilizationInput = {
  availableHours: number
  allocatedHours: number
  actualHours: number
  billableHours: number
}

export type UtilizationMetrics = UtilizationInput & {
  nonBillableHours: number
  /** Actual ÷ Available. Not capped at 100 so overtime is visible. */
  utilizationPercent: number
  /** Billable ÷ Available. */
  billableUtilizationPercent: number
  /** Allocated ÷ Available (planned load). */
  allocationPercent: number
  /** Billable ÷ Actual (what share of logged time was billable). */
  billablePercent: number
  /** Available − Actual. Positive = idle capacity, negative = overtime. */
  varianceHours: number
  status: UtilizationStatus
}

/**
 * Derive the utilization metric set for a single resource/period from its four
 * raw hour inputs. Pure and side-effect free so it can be validated directly
 * against timesheet numbers. Inputs are clamped defensively:
 *   * negatives → 0
 *   * billable can never exceed actual (keeps non-billable ≥ 0, billable% ≤ 100)
 */
export function computeUtilizationMetrics(input: UtilizationInput): UtilizationMetrics {
  const availableHours = Math.max(0, round2(toNumber(input.availableHours)))
  const allocatedHours = Math.max(0, round2(toNumber(input.allocatedHours)))
  const actualHours = Math.max(0, round2(toNumber(input.actualHours)))
  const billableHours = Math.max(0, Math.min(round2(toNumber(input.billableHours)), actualHours))
  const nonBillableHours = round2(actualHours - billableHours)

  const utilizationPercent = pct(actualHours, availableHours)
  const billableUtilizationPercent = pct(billableHours, availableHours)
  const allocationPercent = pct(allocatedHours, availableHours)
  const billablePercent = pct(billableHours, actualHours)
  const varianceHours = round2(availableHours - actualHours)

  let status: UtilizationStatus
  if (availableHours <= 0) status = "No Capacity"
  else if (actualHours <= 0) status = "Idle"
  else if (utilizationPercent > 100) status = "Over-allocated"
  else if (utilizationPercent >= UTILIZATION_TARGET_PERCENT) status = "Optimal"
  else status = "Under-utilized"

  return {
    availableHours,
    allocatedHours,
    actualHours,
    billableHours,
    nonBillableHours,
    utilizationPercent,
    billableUtilizationPercent,
    allocationPercent,
    billablePercent,
    varianceHours,
    status,
  }
}

export type AllocationRecord = {
  allocation_percent?: unknown
  allocated_capacity?: unknown
  from_date?: unknown
  to_date?: unknown
  status?: unknown
}

/** Inclusive first/last calendar day of a `YYYY-MM` period. */
function periodRange(period: string): { start: string; end: string } {
  const [year, month] = period.split("-").map(Number)
  const start = `${period}-01`
  // Day 0 of the next month === last day of this month (UTC-safe).
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  return { start, end }
}

/**
 * Allocated hours for a resource within a `YYYY-MM` period, summed across every
 * allocation whose date range overlaps that month. Uses each allocation's
 * explicit `allocated_capacity` when present, otherwise derives it from
 * `allocation_percent` × the resource's available capacity. An allocation with
 * no dates is treated as always active. Pure — exported for tests.
 */
export function allocatedHoursForPeriod(
  allocations: AllocationRecord[],
  period: string,
  availableHours: number,
): number {
  if (!/^\d{4}-\d{2}$/.test(period)) return 0
  const { start, end } = periodRange(period)
  let total = 0
  for (const allocation of allocations) {
    const from = allocation.from_date ? String(allocation.from_date).slice(0, 10) : null
    const to = allocation.to_date ? String(allocation.to_date).slice(0, 10) : null
    // Overlap test: starts on/before the month end AND ends on/after month start.
    if (from && from > end) continue
    if (to && to < start) continue
    const explicit = toNumber(allocation.allocated_capacity)
    if (explicit > 0) {
      total += explicit
      continue
    }
    const percent = toNumber(allocation.allocation_percent)
    if (percent > 0) total += (percent / 100) * Math.max(0, availableHours)
  }
  return round2(total)
}

// ---------------------------------------------------------------------------
// PHASE 2 — Aggregation service
// ---------------------------------------------------------------------------

export type UtilizationRow = UtilizationMetrics & {
  resource_id: string
  resource_name: string
  period: string
}

export type UtilizationSummary = {
  resourceCount: number
  rowCount: number
  availableHours: number
  allocatedHours: number
  actualHours: number
  billableHours: number
  utilizationPercent: number
  billableUtilizationPercent: number
  allocationPercent: number
  billablePercent: number
  overAllocatedCount: number
  underUtilizedCount: number
}

export type UtilizationReport = {
  rows: UtilizationRow[]
  summary: UtilizationSummary
}

function emptySummary(): UtilizationSummary {
  return {
    resourceCount: 0,
    rowCount: 0,
    availableHours: 0,
    allocatedHours: 0,
    actualHours: 0,
    billableHours: 0,
    utilizationPercent: 0,
    billableUtilizationPercent: 0,
    allocationPercent: 0,
    billablePercent: 0,
    overAllocatedCount: 0,
    underUtilizedCount: 0,
  }
}

/** Roll a set of per-resource/period rows into portfolio totals. Pure. */
export function summarizeUtilization(rows: UtilizationRow[]): UtilizationSummary {
  if (!rows.length) return emptySummary()
  const totals = rows.reduce(
    (acc, r) => {
      acc.available += r.availableHours
      acc.allocated += r.allocatedHours
      acc.actual += r.actualHours
      acc.billable += r.billableHours
      return acc
    },
    { available: 0, allocated: 0, actual: 0, billable: 0 },
  )
  return {
    resourceCount: new Set(rows.map((r) => r.resource_id || r.resource_name.toLowerCase())).size,
    rowCount: rows.length,
    availableHours: round2(totals.available),
    allocatedHours: round2(totals.allocated),
    actualHours: round2(totals.actual),
    billableHours: round2(totals.billable),
    utilizationPercent: pct(totals.actual, totals.available),
    billableUtilizationPercent: pct(totals.billable, totals.available),
    allocationPercent: pct(totals.allocated, totals.available),
    billablePercent: pct(totals.billable, totals.actual),
    overAllocatedCount: rows.filter((r) => r.status === "Over-allocated").length,
    underUtilizedCount: rows.filter((r) => r.status === "Under-utilized").length,
  }
}

/** resource_id / lowercased-name → monthly available capacity (hours). */
async function resourceCapacityIndex(): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  const cols = await tableColumns("operations_resources")
  if (!cols.has("capacity_hours")) return index
  const rows = await query<any[]>(
    `SELECT resource_id, resource_name, capacity_hours FROM operations_resources`,
  ).catch(() => [] as any[])
  for (const r of rows) {
    const cap = toNumber(r.capacity_hours)
    const value = cap > 0 ? cap : 0
    if (r.resource_id != null && String(r.resource_id) !== "") index.set(`id:${String(r.resource_id)}`, value)
    if (r.resource_name) index.set(`name:${String(r.resource_name).toLowerCase()}`, value)
  }
  return index
}

function resolveCapacity(index: Map<string, number>, id: unknown, name: unknown): number {
  const value =
    index.get(`id:${String(id ?? "")}`) ?? index.get(`name:${String(name ?? "").toLowerCase()}`)
  return value && value > 0 ? value : DEFAULT_MONTHLY_CAPACITY_HOURS
}

/** resource_id / lowercased-name → its allocation records. */
async function resourceAllocationIndex(): Promise<Map<string, AllocationRecord[]>> {
  const index = new Map<string, AllocationRecord[]>()
  const cols = await tableColumns("operations_allocations")
  if (!cols.size) return index
  const rows = await query<any[]>(
    `SELECT resource_id, resource_name, allocation_percent, allocated_capacity, from_date, to_date, status
       FROM operations_allocations`,
  ).catch(() => [] as any[])
  const push = (key: string, rec: AllocationRecord) => {
    const list = index.get(key)
    if (list) list.push(rec)
    else index.set(key, [rec])
  }
  for (const r of rows) {
    const rec: AllocationRecord = {
      allocation_percent: r.allocation_percent,
      allocated_capacity: r.allocated_capacity,
      from_date: r.from_date,
      to_date: r.to_date,
      status: r.status,
    }
    if (r.resource_id != null && String(r.resource_id) !== "") push(`id:${String(r.resource_id)}`, rec)
    if (r.resource_name) push(`name:${String(r.resource_name).toLowerCase()}`, rec)
  }
  return index
}

function resolveAllocations(
  index: Map<string, AllocationRecord[]>,
  id: unknown,
  name: unknown,
): AllocationRecord[] {
  // Prefer id match, then name match, so a record is never counted twice.
  return (
    index.get(`id:${String(id ?? "")}`) ?? index.get(`name:${String(name ?? "").toLowerCase()}`) ?? []
  )
}

/**
 * Build the utilization report from approved timesheets, one row per resource
 * per period (`YYYY-MM`). Available capacity comes from the Resources master
 * and allocated hours from active allocations; actual/billable come straight
 * from approved timesheet sums so the report always reconciles to timesheets.
 */
export async function utilizationReport(options?: { period?: string }): Promise<UtilizationReport> {
  const tsCols = await tableColumns("operations_timesheets")
  if (!tsCols.size) return { rows: [], summary: emptySummary() }

  const billableExpr = tsCols.has("billable_hours") ? "COALESCE(SUM(billable_hours),0)" : "0"
  const nonBillableExpr = tsCols.has("non_billable_hours") ? "COALESCE(SUM(non_billable_hours),0)" : "0"

  const where: string[] = ["approval_status = 'Approved'", "work_date IS NOT NULL"]
  const args: unknown[] = []
  const period = options?.period
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    where.push("LEFT(work_date,7) = ?")
    args.push(period)
  }

  const tsRows = await query<any[]>(
    `SELECT resource_id, resource_name, LEFT(work_date,7) period,
            COALESCE(SUM(hours_worked),0) actual,
            ${billableExpr} billable,
            ${nonBillableExpr} nonbillable
       FROM operations_timesheets
      WHERE ${where.join(" AND ")}
      GROUP BY resource_id, resource_name, LEFT(work_date,7)`,
    args,
  ).catch(() => [] as any[])
  if (!tsRows.length) return { rows: [], summary: emptySummary() }

  const capacityIndex = await resourceCapacityIndex()
  const allocationIndex = await resourceAllocationIndex()

  const rows: UtilizationRow[] = tsRows.map((r) => {
    const rowPeriod = r.period ? String(r.period) : ""
    const availableHours = resolveCapacity(capacityIndex, r.resource_id, r.resource_name)
    const allocations = resolveAllocations(allocationIndex, r.resource_id, r.resource_name)
    const allocatedHours = allocatedHoursForPeriod(allocations, rowPeriod, availableHours)
    const metrics = computeUtilizationMetrics({
      availableHours,
      allocatedHours,
      actualHours: toNumber(r.actual),
      billableHours: toNumber(r.billable),
    })
    return {
      resource_id: String(r.resource_id ?? ""),
      resource_name: r.resource_name ? String(r.resource_name) : "Unknown resource",
      period: rowPeriod,
      ...metrics,
    }
  })

  rows.sort(
    (a, b) => b.period.localeCompare(a.period) || b.utilizationPercent - a.utilizationPercent,
  )

  return { rows, summary: summarizeUtilization(rows) }
}
