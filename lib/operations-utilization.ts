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
//
// The pure calculations and types live in `operations-utilization-shared` so
// they can also be imported from Client Components without pulling in the
// server-only database layer. They are re-exported here for backwards compat.
// =============================================================================

import { query, tableColumns } from "@/lib/db"
import {
  toNumber,
  computeUtilizationMetrics,
  allocatedHoursForPeriod,
  summarizeUtilization,
  emptySummary,
  DEFAULT_MONTHLY_CAPACITY_HOURS,
  type AllocationRecord,
  type UtilizationRow,
  type UtilizationReport,
} from "@/lib/operations-utilization-shared"

// Re-export the pure surface so existing imports of "@/lib/operations-utilization"
// (tests, API routes) keep working exactly as before.
export * from "@/lib/operations-utilization-shared"

// ---------------------------------------------------------------------------
// PHASE 2 — Aggregation service (server-only: touches the database)
// ---------------------------------------------------------------------------

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
