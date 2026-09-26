/**
 * SPEC 44 (#205) — pure resource conflict, availability and resolution logic.
 * No DB access so the detection/resolution rules can be unit-tested directly.
 */

export const ACTIVE_ALLOCATION_STATUSES = ["Planned", "Active", "Partially Allocated", "Over Allocated"]
export const APPROVED_LEAVE_STATUSES = ["HR Approved"]

export type ConflictType = "over_allocation" | "overlap" | "capacity_exceeded" | "on_leave"

export type AllocationRow = {
  id?: number | string | null
  allocation_id?: number | string | null
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

export type Conflict = {
  key: string
  type: ConflictType
  severity: "warning" | "critical"
  resource_id: string | null
  resource_name: string | null
  message: string
  detail: string
  allocation_ids: string[]
  related: Array<Record<string, unknown>>
}

export type ResolutionAction = "reduce_percent" | "shift_dates" | "release" | "accept"
export const RESOLUTION_ACTIONS: ResolutionAction[] = ["reduce_percent", "shift_dates", "release", "accept"]

export type ResolutionInput = {
  conflict_key: string
  action: ResolutionAction
  allocation_id?: string | number | null
  allocation_percent?: number | null
  from_date?: string | null
  to_date?: string | null
  reason?: string | null
}

export type AllocationPatch = Partial<Pick<AllocationRow, "allocation_percent" | "from_date" | "to_date" | "status">>

const FAR_FUTURE = "9999-12-31"
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
  return Number.isFinite(parsed) ? parsed : 0
}

export function isoDate(value: unknown): string | null {
  if (value == null || value === "") return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  const s = String(value).slice(0, 10)
  return DATE_RE.test(s) ? s : null
}

function toTime(date: string | null, fallback: string) {
  return new Date(`${isoDate(date) ?? fallback}T00:00:00Z`).getTime()
}

export function rangesOverlap(aFrom: string | null, aTo: string | null, bFrom: string | null, bTo: string | null) {
  return toTime(aFrom, "1970-01-01") <= toTime(bTo, FAR_FUTURE) && toTime(bFrom, "1970-01-01") <= toTime(aTo, FAR_FUTURE)
}

export function allocationId(row: AllocationRow): string {
  return String(row.id ?? row.allocation_id ?? "")
}

export function resourceKey(row: { resource_id: string | null; resource_name: string | null }) {
  if (row.resource_id != null && String(row.resource_id).trim() !== "") return `id:${row.resource_id}`
  if (row.resource_name) return `name:${row.resource_name.trim().toLowerCase()}`
  return "unknown"
}

/** Stable identity of a conflict: type + resource + the sorted allocation ids involved. */
export function conflictKey(type: ConflictType, resource: string, ids: string[], extra = ""): string {
  return [type, resource, [...ids].sort().join("+"), extra].filter(Boolean).join("|")
}

const CANDIDATE_ID = "__candidate__"

export function detectConflicts(allocations: AllocationRow[], leaves: LeaveRow[], candidate?: AllocationRow): Conflict[] {
  const conflicts: Conflict[] = []
  const rows = candidate ? [...allocations, candidate] : allocations
  const idOf = (row: AllocationRow) => (candidate != null && row === candidate ? CANDIDATE_ID : allocationId(row))
  const label = (row: AllocationRow) => row.project_id ?? row.client_name ?? "a project"
  const newTag = (row: AllocationRow) => (candidate != null && row === candidate ? " (new allocation)" : "")

  const byResource = new Map<string, AllocationRow[]>()
  for (const row of rows) {
    const key = resourceKey(row)
    if (key === "unknown") continue
    const list = byResource.get(key) ?? []
    list.push(row)
    byResource.set(key, list)
  }

  for (const [resKey, list] of byResource) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (num(a.allocated_capacity) > 0 && num(a.working_capacity) > 0 && num(a.allocated_capacity) > num(a.working_capacity)) {
        const ids = [idOf(a)]
        conflicts.push({
          key: conflictKey("capacity_exceeded", resKey, ids),
          type: "capacity_exceeded",
          severity: "critical",
          resource_id: a.resource_id,
          resource_name: a.resource_name,
          message: `${a.resource_name ?? "Resource"} is allocated beyond working capacity`,
          detail: `Allocated ${num(a.allocated_capacity)}h against a working capacity of ${num(a.working_capacity)}h${newTag(a)}.`,
          allocation_ids: ids,
          related: [a as Record<string, unknown>],
        })
      }
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (!rangesOverlap(a.from_date, a.to_date, b.from_date, b.to_date)) continue
        const combined = num(a.allocation_percent) + num(b.allocation_percent)
        const ids = [idOf(a), idOf(b)]
        const over = combined > 100
        const type: ConflictType = over ? "over_allocation" : "overlap"
        conflicts.push({
          key: conflictKey(type, resKey, ids),
          type,
          severity: over ? "critical" : "warning",
          resource_id: a.resource_id ?? b.resource_id,
          resource_name: a.resource_name ?? b.resource_name,
          message: over
            ? `${a.resource_name ?? "Resource"} is over-allocated (${combined}%)`
            : `${a.resource_name ?? "Resource"} has overlapping project assignments`,
          detail: over
            ? `Overlapping allocations total ${combined}% between ${label(a)} and ${label(b)}.`
            : `Assigned to ${label(a)} and ${label(b)} over the same dates (${combined}% total).`,
          allocation_ids: ids,
          related: [a as Record<string, unknown>, b as Record<string, unknown>],
        })
      }
    }
  }

  for (const row of rows) {
    const name = row.resource_name?.trim().toLowerCase()
    if (!name) continue
    for (const leave of leaves) {
      if (!APPROVED_LEAVE_STATUSES.includes(leave.status)) continue
      if (leave.employee_name?.trim().toLowerCase() !== name) continue
      if (!rangesOverlap(row.from_date, row.to_date, leave.from_date, leave.to_date)) continue
      const ids = [idOf(row)]
      const leaveWindow = `${isoDate(leave.from_date)}..${isoDate(leave.to_date)}`
      conflicts.push({
        key: conflictKey("on_leave", resourceKey(row), ids, leaveWindow),
        type: "on_leave",
        severity: "critical",
        resource_id: row.resource_id,
        resource_name: row.resource_name,
        message: `${row.resource_name} is on approved leave during this allocation`,
        detail: `Approved leave ${isoDate(leave.from_date)} → ${isoDate(leave.to_date)} overlaps allocation to ${label(row)}${newTag(row)}.`,
        allocation_ids: ids,
        related: [row as Record<string, unknown>, leave as unknown as Record<string, unknown>],
      })
    }
  }

  return conflicts
}

export type ResourceAvailability = {
  resource_key: string
  resource_id: string | null
  resource_name: string | null
  peak_allocation_percent: number
  available_percent: number
  allocations: number
  leave_days: number
  status: "Available" | "Partially Available" | "Fully Allocated" | "Over Allocated"
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function clampWindow(from: string | null, to: string | null, winFrom: string, winTo: string): [string, string] | null {
  const start = (isoDate(from) ?? winFrom) > winFrom ? (isoDate(from) as string) : winFrom
  const end = (isoDate(to) ?? winTo) < winTo ? (isoDate(to) as string) : winTo
  return start <= end ? [start, end] : null
}

/**
 * Peak concurrent allocation % per resource in [from, to] using a sweep over
 * range boundaries (ranges are inclusive), plus approved-leave day count.
 */
export function computeAvailability(
  allocations: AllocationRow[],
  leaves: LeaveRow[],
  from: string,
  to: string,
): ResourceAvailability[] {
  const groups = new Map<string, AllocationRow[]>()
  for (const row of allocations) {
    const key = resourceKey(row)
    if (key === "unknown") continue
    if (!clampWindow(row.from_date, row.to_date, from, to)) continue
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const result: ResourceAvailability[] = []
  for (const [key, list] of groups) {
    const events: Array<[string, number]> = []
    for (const row of list) {
      const [s, e] = clampWindow(row.from_date, row.to_date, from, to) as [string, string]
      events.push([s, num(row.allocation_percent)], [addDays(e, 1), -num(row.allocation_percent)])
    }
    events.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1))
    let running = 0
    let peak = 0
    for (const [, delta] of events) {
      running += delta
      if (running > peak) peak = running
    }
    peak = Math.round(peak * 100) / 100

    const name = list[0].resource_name?.trim().toLowerCase()
    const leaveDates = new Set<string>()
    for (const leave of leaves) {
      if (!APPROVED_LEAVE_STATUSES.includes(leave.status)) continue
      if (!name || leave.employee_name?.trim().toLowerCase() !== name) continue
      const w = clampWindow(leave.from_date, leave.to_date, from, to)
      if (!w) continue
      for (let d = w[0]; d <= w[1]; d = addDays(d, 1)) leaveDates.add(d)
    }

    result.push({
      resource_key: key,
      resource_id: list[0].resource_id,
      resource_name: list[0].resource_name,
      peak_allocation_percent: peak,
      available_percent: Math.max(0, Math.round((100 - peak) * 100) / 100),
      allocations: list.length,
      leave_days: leaveDates.size,
      status: peak > 100 ? "Over Allocated" : peak === 100 ? "Fully Allocated" : peak > 0 ? "Partially Available" : "Available",
    })
  }
  return result.sort((a, b) => b.peak_allocation_percent - a.peak_allocation_percent)
}

export class ResolutionError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message)
    this.name = "ResolutionError"
  }
}

/** Validate a resolution request's shape. Throws ResolutionError (400). */
export function parseResolutionInput(body: unknown): ResolutionInput {
  if (!body || typeof body !== "object") throw new ResolutionError("Invalid request body")
  const b = body as Record<string, unknown>
  const key = typeof b.conflict_key === "string" ? b.conflict_key.trim() : ""
  if (!key || key.length > 500) throw new ResolutionError("conflict_key is required")
  const action = b.action as ResolutionAction
  if (!RESOLUTION_ACTIONS.includes(action)) throw new ResolutionError(`action must be one of ${RESOLUTION_ACTIONS.join(", ")}`)
  const reason = b.reason != null ? String(b.reason).trim().slice(0, 500) : null
  const input: ResolutionInput = { conflict_key: key, action, reason }

  if (action === "accept") {
    if (!reason) throw new ResolutionError("A reason is required to accept a conflict")
    return input
  }
  if (b.allocation_id == null || String(b.allocation_id).trim() === "") {
    throw new ResolutionError("allocation_id is required for this action")
  }
  input.allocation_id = String(b.allocation_id)
  if (action === "reduce_percent") {
    const pct = Number(b.allocation_percent)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new ResolutionError("allocation_percent must be between 0 and 100")
    input.allocation_percent = Math.round(pct * 100) / 100
  }
  if (action === "shift_dates") {
    const f = isoDate(b.from_date)
    const t = b.to_date == null || b.to_date === "" ? null : isoDate(b.to_date)
    if (!f) throw new ResolutionError("from_date must be YYYY-MM-DD")
    if (b.to_date != null && b.to_date !== "" && !t) throw new ResolutionError("to_date must be YYYY-MM-DD")
    if (t && t < f) throw new ResolutionError("to_date must be on or after from_date")
    input.from_date = f
    input.to_date = t
  }
  return input
}

export function patchFor(input: ResolutionInput, current: AllocationRow): AllocationPatch {
  switch (input.action) {
    case "reduce_percent":
      if (num(input.allocation_percent) >= num(current.allocation_percent)) {
        throw new ResolutionError("New allocation % must be lower than the current allocation")
      }
      return { allocation_percent: input.allocation_percent ?? 0 }
    case "shift_dates":
      return { from_date: input.from_date ?? null, to_date: input.to_date ?? null }
    case "release":
      return { status: "Released" }
    default:
      return {}
  }
}

/**
 * Plan a resolution against the current allocation set: locate the conflict,
 * verify the target allocation is part of it, compute the patch and prove the
 * conflict disappears once it is applied. Throws ResolutionError on failure.
 */
export function planResolution(
  input: ResolutionInput,
  allocations: AllocationRow[],
  leaves: LeaveRow[],
): { conflict: Conflict; target: AllocationRow | null; patch: AllocationPatch } {
  const conflict = detectConflicts(allocations, leaves).find((c) => c.key === input.conflict_key)
  if (!conflict) throw new ResolutionError("Conflict not found or already resolved", 409)
  if (input.action === "accept") return { conflict, target: null, patch: {} }

  const target = allocations.find((a) => allocationId(a) === String(input.allocation_id))
  if (!target || !conflict.allocation_ids.includes(allocationId(target))) {
    throw new ResolutionError("allocation_id is not part of this conflict")
  }
  const patch = patchFor(input, target)
  const next = allocations
    .map((a) => (a === target ? { ...a, ...patch } : a))
    .filter((a) => !a.status || ACTIVE_ALLOCATION_STATUSES.includes(a.status))
  if (detectConflicts(next, leaves).some((c) => c.key === input.conflict_key)) {
    throw new ResolutionError("This change does not resolve the conflict", 422)
  }
  return { conflict, target, patch }
}
