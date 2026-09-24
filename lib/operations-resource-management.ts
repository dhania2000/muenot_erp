import "server-only"
// =============================================================================
// Project Resource Management (SPEC 147) — resource model + allocation engine.
// -----------------------------------------------------------------------------
// PHASE 1 audit conclusion: the raw building blocks already exist as flat
// modules — operations_resources (the resource master: capacity, cost rate,
// availability), operations_projects (client/project mapping) and
// operations_allocations (who is assigned to what, for how long, at what %).
// Resource-conflict detection also already lived *inline* inside the
// resource-conflicts API route. What was missing is:
//
//   * a normalized RESOURCE MODEL that joins those tables into one view with
//     the seven SPEC-147 dimensions per resource — assignment, capacity,
//     allocation, availability, utilization, cost and billing;
//   * roll-ups by resource / project / client;
//   * a single, reusable, unit-testable allocation-CONFLICT engine (extracted
//     from the route so the route and the tests exercise the same code).
//
// Everything here is pure and side-effect free except resourceManagementReport(),
// which is the only DB-backed export. The pure calculators/aggregators and the
// conflict engine take plain inputs and are exported for direct validation
// (Phase 4), so the derived numbers always reconcile to the source allocations.
// =============================================================================

import { query, tableColumns } from "@/lib/db"

/** Allocation statuses that represent a live commitment of a resource's time.
 *  Released / completed / cancelled allocations no longer consume capacity. */
export const ACTIVE_ALLOCATION_STATUSES = ["Planned", "Active", "Partially Allocated", "Over Allocated"]

/** Leave-request statuses that count as an approved absence. */
export const APPROVED_LEAVE_STATUSES = ["HR Approved"]

/** Hours assumed per month when converting a monthly cost rate to hourly. */
const MONTHLY_HOURS = 160
/** Hours assumed per day when converting a daily cost rate to hourly. */
const DAILY_HOURS = 8

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
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
// PHASE 1 — Calculations (pure, side-effect free, exported for validation)
// ---------------------------------------------------------------------------

export type RawAllocation = {
  allocation_id?: unknown
  id?: unknown
  resource_id?: unknown
  resource_name?: unknown
  resource_type?: unknown
  project_id?: unknown
  client_name?: unknown
  role?: unknown
  allocation_percent?: unknown
  from_date?: unknown
  to_date?: unknown
  working_capacity?: unknown
  allocated_capacity?: unknown
  available_capacity?: unknown
  status?: unknown
}

/**
 * The committed hours an allocation consumes. Prefer an explicit
 * `allocated_capacity`; otherwise derive it from the resource's working
 * capacity and the allocation percentage. Never negative. Pure.
 */
export function allocationHours(raw: RawAllocation): number {
  const allocated = num(raw.allocated_capacity)
  if (allocated > 0) return round2(allocated)
  const capacity = num(raw.working_capacity)
  const percent = num(raw.allocation_percent)
  if (capacity > 0 && percent > 0) return round2((capacity * percent) / 100)
  return 0
}

/** Remaining bookable hours given capacity and already-allocated hours.
 *  Clamped at 0 — an over-allocated resource has *no* availability, not
 *  negative availability (over-allocation is tracked separately). Pure. */
export function availabilityHours(capacityHours: number, allocatedHours: number): number {
  return round2(Math.max(0, num(capacityHours) - num(allocatedHours)))
}

/** Utilization = allocated / capacity, as a percentage. 0 when capacity is 0. Pure. */
export function utilizationPercent(allocatedHours: number, capacityHours: number): number {
  return pct(num(allocatedHours), num(capacityHours))
}

/** Convert a stored cost rate to an hourly figure using its rate_type. Pure. */
export function normaliseToHourly(costRate: unknown, rateType: unknown): number {
  const rate = num(costRate)
  const type = String(rateType ?? "").toLowerCase()
  if (type === "monthly") return round2(rate / MONTHLY_HOURS)
  if (type === "daily") return round2(rate / DAILY_HOURS)
  return round2(rate) // hourly / fixed / unknown → treat as already hourly
}

// ---------------------------------------------------------------------------
// PHASE 4 — Allocation conflict engine (pure; shared by route + tests)
// ---------------------------------------------------------------------------

export type ConflictType = "over_allocation" | "overlap" | "capacity_exceeded" | "on_leave"

export type AllocationConflict = {
  type: ConflictType
  severity: "warning" | "critical"
  resource_id: string | null
  resource_name: string | null
  message: string
  detail: string
  related: Array<Record<string, unknown>>
}

export type ConflictAllocationRow = {
  allocation_id?: number
  id?: number
  resource_id: string | null
  resource_name: string | null
  project_id: string | null
  client_name: string | null
  role: string | null
  allocation_percent: number | null
  from_date: string | null
  to_date: string | null
  working_capacity: number | null
  allocated_capacity: number | null
  status: string | null
}

export type LeaveRow = {
  employee_name: string | null
  employee_id: number | null
  from_date: string
  to_date: string
  status: string
}

const FAR_FUTURE = "9999-12-31"

function toTime(date: string | null, fallback: string): number {
  const value = date && date.length >= 10 ? date.slice(0, 10) : fallback
  return new Date(`${value}T00:00:00Z`).getTime()
}

/** Two closed date ranges overlap when each starts on or before the other ends.
 *  Open ends (null) extend to -inf / +inf. Pure. */
export function rangesOverlap(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null,
): boolean {
  const aStart = toTime(aFrom, "1970-01-01")
  const aEnd = toTime(aTo, FAR_FUTURE)
  const bStart = toTime(bFrom, "1970-01-01")
  const bEnd = toTime(bTo, FAR_FUTURE)
  return aStart <= bEnd && bStart <= aEnd
}

function resourceKey(row: { resource_id: string | null; resource_name: string | null }): string {
  return (
    (row.resource_id != null && String(row.resource_id).trim() !== "" ? `id:${row.resource_id}` : null) ??
    (row.resource_name ? `name:${row.resource_name.trim().toLowerCase()}` : "unknown")
  )
}

/**
 * Core detection: given a set of allocations plus approved leaves, produce the
 * list of conflicts. An optional `candidate` allocation (not yet saved) can be
 * included so callers can PREVIEW the conflicts it would introduce before it is
 * committed. The candidate object is pushed into `related` by identity, so a
 * caller can filter to only the candidate's conflicts. Pure.
 */
export function detectAllocationConflicts(
  allocations: ConflictAllocationRow[],
  leaves: LeaveRow[],
  candidate?: ConflictAllocationRow,
): AllocationConflict[] {
  const conflicts: AllocationConflict[] = []
  const rows = candidate ? [...allocations, candidate] : allocations
  const isCandidate = (row: ConflictAllocationRow) => candidate != null && row === candidate

  // Group by resource for over-allocation + overlap detection.
  const byResource = new Map<string, ConflictAllocationRow[]>()
  for (const row of rows) {
    const key = resourceKey(row)
    if (key === "unknown") continue
    const list = byResource.get(key) ?? []
    list.push(row)
    byResource.set(key, list)
  }

  for (const [, list] of byResource) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      // Capacity exceeded on a single allocation row.
      if (num(a.allocated_capacity) > 0 && num(a.working_capacity) > 0 && num(a.allocated_capacity) > num(a.working_capacity)) {
        conflicts.push({
          type: "capacity_exceeded",
          severity: "critical",
          resource_id: a.resource_id,
          resource_name: a.resource_name,
          message: `${a.resource_name ?? "Resource"} is allocated beyond working capacity`,
          detail: `Allocated ${num(a.allocated_capacity)}h against a working capacity of ${num(a.working_capacity)}h${isCandidate(a) ? " (new allocation)" : ""}.`,
          related: [a as Record<string, unknown>],
        })
      }

      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (!rangesOverlap(a.from_date, a.to_date, b.from_date, b.to_date)) continue

        const combined = num(a.allocation_percent) + num(b.allocation_percent)
        if (combined > 100) {
          conflicts.push({
            type: "over_allocation",
            severity: "critical",
            resource_id: a.resource_id ?? b.resource_id,
            resource_name: a.resource_name ?? b.resource_name,
            message: `${a.resource_name ?? "Resource"} is over-allocated (${combined}%)`,
            detail: `Overlapping allocations total ${combined}% between ${a.project_id ?? a.client_name ?? "a project"} and ${b.project_id ?? b.client_name ?? "another project"}.`,
            related: [a as Record<string, unknown>, b as Record<string, unknown>],
          })
        } else {
          conflicts.push({
            type: "overlap",
            severity: "warning",
            resource_id: a.resource_id ?? b.resource_id,
            resource_name: a.resource_name ?? b.resource_name,
            message: `${a.resource_name ?? "Resource"} has overlapping project assignments`,
            detail: `Assigned to ${a.project_id ?? a.client_name ?? "a project"} and ${b.project_id ?? b.client_name ?? "another project"} over the same dates (${combined}% total).`,
            related: [a as Record<string, unknown>, b as Record<string, unknown>],
          })
        }
      }
    }
  }

  // Employee on approved leave during an allocation window.
  for (const row of rows) {
    const name = row.resource_name?.trim().toLowerCase()
    if (!name) continue
    for (const leave of leaves) {
      if (!leave.employee_name) continue
      if (leave.employee_name.trim().toLowerCase() !== name) continue
      if (!rangesOverlap(row.from_date, row.to_date, leave.from_date, leave.to_date)) continue
      conflicts.push({
        type: "on_leave",
        severity: "critical",
        resource_id: row.resource_id,
        resource_name: row.resource_name,
        message: `${row.resource_name} is on approved leave during this allocation`,
        detail: `Approved leave ${leave.from_date?.slice(0, 10)} → ${leave.to_date?.slice(0, 10)} overlaps allocation to ${row.project_id ?? row.client_name ?? "a project"}${isCandidate(row) ? " (new allocation)" : ""}.`,
        related: [row as Record<string, unknown>, leave as unknown as Record<string, unknown>],
      })
    }
  }

  return conflicts
}

/** Tally conflicts by type — the summary the conflict route and dashboard show. */
export function summarizeConflicts(conflicts: AllocationConflict[]) {
  return {
    total: conflicts.length,
    over_allocation: conflicts.filter((c) => c.type === "over_allocation").length,
    overlap: conflicts.filter((c) => c.type === "overlap").length,
    capacity_exceeded: conflicts.filter((c) => c.type === "capacity_exceeded").length,
    on_leave: conflicts.filter((c) => c.type === "on_leave").length,
  }
}

// ---------------------------------------------------------------------------
// PHASE 2 — Normalized resource model + aggregation (pure)
// ---------------------------------------------------------------------------

/** Master data for a resource, resolved from operations_resources. */
export type ResourceMaster = {
  capacityHours: number
  hourlyRate: number
  availabilityStatus: string
}

/** id/name → master. The resolver falls back to name when no id match exists. */
export type ResourceMasterResolver = (resourceId: string, resourceName: string) => ResourceMaster | undefined

export type Allocation = {
  allocation_id: string
  resource_id: string
  resource_name: string
  resource_type: string
  project_id: string
  client_name: string
  role: string
  allocationPercent: number
  fromDate: string
  toDate: string
  workingCapacity: number
  allocatedHours: number
  status: string
  /** Client-facing allocations (a client is named) are billable; internal/bench work is not. */
  billable: boolean
}

/** Normalize a raw allocation row into the canonical Allocation shape. Pure. */
export function normalizeAllocation(raw: RawAllocation): Allocation {
  const clientName = raw.client_name ? String(raw.client_name).trim() : ""
  return {
    allocation_id: raw.allocation_id != null ? String(raw.allocation_id) : raw.id != null ? String(raw.id) : "",
    resource_id: raw.resource_id != null ? String(raw.resource_id) : "",
    resource_name: raw.resource_name ? String(raw.resource_name) : "Unknown resource",
    resource_type: raw.resource_type ? String(raw.resource_type) : "",
    project_id: raw.project_id != null ? String(raw.project_id) : "",
    client_name: clientName || "Internal",
    role: raw.role ? String(raw.role) : "",
    allocationPercent: round2(num(raw.allocation_percent)),
    fromDate: raw.from_date ? String(raw.from_date).slice(0, 10) : "",
    toDate: raw.to_date ? String(raw.to_date).slice(0, 10) : "",
    workingCapacity: round2(num(raw.working_capacity)),
    allocatedHours: allocationHours(raw),
    status: raw.status ? String(raw.status) : "",
    billable: clientName !== "",
  }
}

function allocationResourceKey(a: Allocation): string {
  return a.resource_id || a.resource_name.toLowerCase()
}

export type ResourceRow = {
  key: string
  resource_id: string
  resource_name: string
  resource_type: string
  capacityHours: number
  allocatedHours: number
  availableHours: number
  allocationPercent: number
  utilizationPercent: number
  hourlyRate: number
  costAmount: number
  billableHours: number
  billableCost: number
  billablePercent: number
  projectCount: number
  allocationCount: number
  availabilityStatus: string
  overAllocated: boolean
}

/**
 * Roll allocations up per resource, joining capacity/rate/availability from the
 * resource master. Produces the seven SPEC-147 dimensions per resource:
 * assignment (allocations/projects), capacity, allocation (hours + %),
 * availability, utilization, cost and billing. Pure.
 */
export function rollupByResource(
  allocations: Allocation[],
  resolveMaster?: ResourceMasterResolver,
): ResourceRow[] {
  const groups = new Map<string, Allocation[]>()
  for (const a of allocations) {
    const key = allocationResourceKey(a)
    const list = groups.get(key) ?? []
    list.push(a)
    groups.set(key, list)
  }

  const rows: ResourceRow[] = []
  for (const [key, list] of groups) {
    const first = list[0]
    const master = resolveMaster?.(first.resource_id, first.resource_name)
    // Capacity: master capacity is the truth; else the largest per-allocation
    // working-capacity snapshot; else 0.
    const capacityHours = round2(
      master && master.capacityHours > 0
        ? master.capacityHours
        : Math.max(0, ...list.map((a) => a.workingCapacity)),
    )
    const allocatedHours = round2(list.reduce((s, a) => s + a.allocatedHours, 0))
    const allocationPercent = round2(list.reduce((s, a) => s + a.allocationPercent, 0))
    const hourlyRate = round2(master?.hourlyRate ?? 0)
    const billableHours = round2(list.filter((a) => a.billable).reduce((s, a) => s + a.allocatedHours, 0))
    const costAmount = round2(allocatedHours * hourlyRate)
    const billableCost = round2(billableHours * hourlyRate)

    rows.push({
      key,
      resource_id: first.resource_id,
      resource_name: first.resource_name,
      resource_type: first.resource_type,
      capacityHours,
      allocatedHours,
      availableHours: availabilityHours(capacityHours, allocatedHours),
      allocationPercent,
      utilizationPercent: utilizationPercent(allocatedHours, capacityHours),
      hourlyRate,
      costAmount,
      billableHours,
      billableCost,
      billablePercent: pct(billableHours, allocatedHours),
      projectCount: new Set(list.filter((a) => a.project_id).map((a) => a.project_id)).size,
      allocationCount: list.length,
      availabilityStatus: master?.availabilityStatus ?? "",
      overAllocated: allocatedHours > capacityHours && capacityHours > 0,
    })
  }

  rows.sort((a, b) => b.utilizationPercent - a.utilizationPercent || b.allocatedHours - a.allocatedHours)
  return rows
}

export type GroupRow = {
  key: string
  label: string
  resourceCount: number
  allocationCount: number
  allocatedHours: number
  costAmount: number
  billableHours: number
  billableCost: number
  billablePercent: number
}

type GroupDimension = "project" | "client"

/** Roll allocations up by project or client. Pure. */
export function rollupByGroup(
  allocations: Allocation[],
  dimension: GroupDimension,
  resolveMaster?: ResourceMasterResolver,
): GroupRow[] {
  const rateOf = (a: Allocation) =>
    round2(resolveMaster?.(a.resource_id, a.resource_name)?.hourlyRate ?? 0)

  const groups = new Map<string, { row: GroupRow; resources: Set<string> }>()
  for (const a of allocations) {
    const key =
      dimension === "project"
        ? a.project_id || a.client_name.toLowerCase() || "unassigned"
        : a.client_name.toLowerCase()
    const label =
      dimension === "project"
        ? a.project_id
          ? `Project ${a.project_id}`
          : a.client_name || "Unassigned"
        : a.client_name

    const entry =
      groups.get(key) ??
      ({
        row: {
          key,
          label,
          resourceCount: 0,
          allocationCount: 0,
          allocatedHours: 0,
          costAmount: 0,
          billableHours: 0,
          billableCost: 0,
          billablePercent: 0,
        } satisfies GroupRow,
        resources: new Set<string>(),
      } as { row: GroupRow; resources: Set<string> })

    const rate = rateOf(a)
    entry.row.allocationCount += 1
    entry.row.allocatedHours = round2(entry.row.allocatedHours + a.allocatedHours)
    entry.row.costAmount = round2(entry.row.costAmount + a.allocatedHours * rate)
    if (a.billable) {
      entry.row.billableHours = round2(entry.row.billableHours + a.allocatedHours)
      entry.row.billableCost = round2(entry.row.billableCost + a.allocatedHours * rate)
    }
    entry.resources.add(allocationResourceKey(a))
    groups.set(key, entry)
  }

  const rows = Array.from(groups.values()).map(({ row, resources }) => ({
    ...row,
    resourceCount: resources.size,
    billablePercent: pct(row.billableHours, row.allocatedHours),
  }))
  rows.sort((a, b) => b.allocatedHours - a.allocatedHours)
  return rows
}

export type ResourceSummary = {
  resourceCount: number
  projectCount: number
  clientCount: number
  allocationCount: number
  totalCapacityHours: number
  totalAllocatedHours: number
  totalAvailableHours: number
  utilizationPercent: number
  overAllocatedCount: number
  benchCount: number
  totalCost: number
  totalBillableCost: number
  billablePercent: number
  conflictCount: number
}

/**
 * Portfolio totals across the per-resource rows. `benchCount` is resources with
 * zero allocated hours (fully available). Aggregate utilization uses summed
 * allocated / summed capacity so it reconciles to the per-resource rows. Pure.
 */
export function summarizeResources(
  rows: ResourceRow[],
  allocations: Allocation[],
  conflictCount = 0,
): ResourceSummary {
  const totalCapacity = round2(rows.reduce((s, r) => s + r.capacityHours, 0))
  const totalAllocated = round2(rows.reduce((s, r) => s + r.allocatedHours, 0))
  const totalAvailable = round2(rows.reduce((s, r) => s + r.availableHours, 0))
  const totalBillableHours = round2(rows.reduce((s, r) => s + r.billableHours, 0))

  return {
    resourceCount: rows.length,
    projectCount: new Set(allocations.filter((a) => a.project_id).map((a) => a.project_id)).size,
    clientCount: new Set(allocations.filter((a) => a.billable).map((a) => a.client_name.toLowerCase())).size,
    allocationCount: allocations.length,
    totalCapacityHours: totalCapacity,
    totalAllocatedHours: totalAllocated,
    totalAvailableHours: totalAvailable,
    utilizationPercent: pct(totalAllocated, totalCapacity),
    overAllocatedCount: rows.filter((r) => r.overAllocated).length,
    benchCount: rows.filter((r) => r.allocatedHours === 0).length,
    totalCost: round2(rows.reduce((s, r) => s + r.costAmount, 0)),
    totalBillableCost: round2(rows.reduce((s, r) => s + r.billableCost, 0)),
    billablePercent: pct(totalBillableHours, totalAllocated),
    conflictCount,
  }
}

// ---------------------------------------------------------------------------
// DB-backed report (the only impure export)
// ---------------------------------------------------------------------------

/** resource_id / lowercased-name → master (capacity, hourly rate, availability). */
async function resourceMasterIndex(): Promise<Map<string, ResourceMaster>> {
  const index = new Map<string, ResourceMaster>()
  const cols = await tableColumns("operations_resources")
  if (!cols.size) return index

  const select: string[] = ["resource_name"]
  const hasResourceId = cols.has("resource_id")
  const hasEmployeeId = cols.has("employee_id")
  const hasCapacity = cols.has("capacity_hours")
  const hasCostRate = cols.has("cost_rate")
  const hasRateType = cols.has("rate_type")
  const hasAvailability = cols.has("availability_status")
  if (hasResourceId) select.push("resource_id")
  if (hasEmployeeId) select.push("employee_id")
  if (hasCapacity) select.push("capacity_hours")
  if (hasCostRate) select.push("cost_rate")
  if (hasRateType) select.push("rate_type")
  if (hasAvailability) select.push("availability_status")

  const rows = await query<any[]>(`SELECT ${select.join(", ")} FROM operations_resources`).catch(
    () => [] as any[],
  )
  for (const r of rows) {
    const master: ResourceMaster = {
      capacityHours: hasCapacity ? num(r.capacity_hours) : 0,
      hourlyRate: hasCostRate ? normaliseToHourly(r.cost_rate, hasRateType ? r.rate_type : null) : 0,
      availabilityStatus: hasAvailability && r.availability_status ? String(r.availability_status) : "",
    }
    if (hasResourceId && r.resource_id != null && String(r.resource_id) !== "")
      index.set(`id:${String(r.resource_id)}`, master)
    if (hasEmployeeId && r.employee_id != null && String(r.employee_id) !== "")
      index.set(`id:${String(r.employee_id)}`, master)
    if (r.resource_name) index.set(`name:${String(r.resource_name).toLowerCase()}`, master)
  }
  return index
}

export type ResourceManagementReport = {
  summary: ResourceSummary
  byResource: ResourceRow[]
  byProject: GroupRow[]
  byClient: GroupRow[]
  conflicts: AllocationConflict[]
  conflictSummary: ReturnType<typeof summarizeConflicts> & { analyzed_allocations: number }
}

function emptyReport(): ResourceManagementReport {
  return {
    summary: summarizeResources([], [], 0),
    byResource: [],
    byProject: [],
    byClient: [],
    conflicts: [],
    conflictSummary: { ...summarizeConflicts([]), analyzed_allocations: 0 },
  }
}

/**
 * Build the normalized resource-management report from operations_allocations,
 * joined to the resource master (capacity/rate/availability) and screened for
 * allocation conflicts against approved leave.
 *
 * Options:
 *   * activeOnly (default true) — restrict to live-commitment statuses so
 *     capacity/utilization reflect current load. Pass false to include all.
 */
export async function resourceManagementReport(options?: {
  activeOnly?: boolean
}): Promise<ResourceManagementReport> {
  const cols = await tableColumns("operations_allocations")
  if (!cols.size) return emptyReport()

  const activeOnly = options?.activeOnly !== false

  const candidateCols = [
    "id",
    "allocation_id",
    "resource_id",
    "resource_name",
    "resource_type",
    "project_id",
    "client_name",
    "role",
    "allocation_percent",
    "from_date",
    "to_date",
    "working_capacity",
    "allocated_capacity",
    "available_capacity",
    "status",
  ]
  const select = candidateCols.filter((c) => cols.has(c))
  if (!select.length) return emptyReport()

  const where: string[] = []
  const args: unknown[] = []
  if (activeOnly && cols.has("status")) {
    where.push(`status IN (${ACTIVE_ALLOCATION_STATUSES.map(() => "?").join(",")})`)
    args.push(...ACTIVE_ALLOCATION_STATUSES)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rawRows = await query<any[]>(
    `SELECT ${select.join(", ")} FROM operations_allocations ${whereSql}`,
    args,
  ).catch(() => [] as any[])
  if (!rawRows.length) return emptyReport()

  const masterIndex = await resourceMasterIndex()
  const resolveMaster: ResourceMasterResolver = (id, name) =>
    masterIndex.get(`id:${id}`) ?? masterIndex.get(`name:${name.toLowerCase()}`)

  const allocations = rawRows.map((r) => normalizeAllocation(r))

  // Conflicts run over the raw rows in the shape the engine expects.
  const conflictRows: ConflictAllocationRow[] = rawRows.map((r) => ({
    allocation_id: r.allocation_id ?? r.id,
    id: r.id,
    resource_id: r.resource_id != null ? String(r.resource_id) : null,
    resource_name: r.resource_name != null ? String(r.resource_name) : null,
    project_id: r.project_id != null ? String(r.project_id) : null,
    client_name: r.client_name != null ? String(r.client_name) : null,
    role: r.role != null ? String(r.role) : null,
    allocation_percent: r.allocation_percent != null ? num(r.allocation_percent) : null,
    from_date: r.from_date != null ? String(r.from_date) : null,
    to_date: r.to_date != null ? String(r.to_date) : null,
    working_capacity: r.working_capacity != null ? num(r.working_capacity) : null,
    allocated_capacity: r.allocated_capacity != null ? num(r.allocated_capacity) : null,
    status: r.status != null ? String(r.status) : null,
  }))

  let leaves: LeaveRow[] = []
  const leaveCols = await tableColumns("hr_leave_requests")
  if (leaveCols.has("employee_name") && leaveCols.has("from_date") && leaveCols.has("to_date")) {
    leaves = await query<LeaveRow[]>(
      `SELECT employee_id, employee_name, from_date, to_date, status FROM hr_leave_requests WHERE status IN (${APPROVED_LEAVE_STATUSES.map(() => "?").join(",")})`,
      APPROVED_LEAVE_STATUSES,
    ).catch(() => [] as LeaveRow[])
  }

  const conflicts = detectAllocationConflicts(conflictRows, leaves)
  const byResource = rollupByResource(allocations, resolveMaster)

  return {
    summary: summarizeResources(byResource, allocations, conflicts.length),
    byResource,
    byProject: rollupByGroup(allocations, "project", resolveMaster),
    byClient: rollupByGroup(allocations, "client", resolveMaster),
    conflicts,
    conflictSummary: { ...summarizeConflicts(conflicts), analyzed_allocations: allocations.length },
  }
}
