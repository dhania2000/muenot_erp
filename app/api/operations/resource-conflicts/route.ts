import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { scopeWhereForModule, mergeScopeIntoWhere } from "@/lib/permission-enforce"

// Statuses that represent a live commitment of a resource's time. Released /
// completed / cancelled allocations no longer consume capacity so they are
// excluded from conflict analysis.
const ACTIVE_ALLOCATION_STATUSES = ["Planned", "Active", "Partially Allocated", "Over Allocated"]

// Leave request statuses that count as an approved absence.
const APPROVED_LEAVE_STATUSES = ["HR Approved"]

type ConflictType = "over_allocation" | "overlap" | "capacity_exceeded" | "on_leave"

type Conflict = {
  type: ConflictType
  severity: "warning" | "critical"
  resource_id: string | null
  resource_name: string | null
  message: string
  detail: string
  related: Array<Record<string, unknown>>
}

type AllocationRow = {
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

type LeaveRow = {
  employee_name: string | null
  employee_id: number | null
  from_date: string
  to_date: string
  status: string
}

const FAR_FUTURE = "9999-12-31"

function toTime(date: string | null, fallback: string) {
  const value = date && date.length >= 10 ? date.slice(0, 10) : fallback
  return new Date(`${value}T00:00:00Z`).getTime()
}

// Two closed date ranges overlap when each starts on or before the other ends.
function rangesOverlap(aFrom: string | null, aTo: string | null, bFrom: string | null, bTo: string | null) {
  const aStart = toTime(aFrom, "1970-01-01")
  const aEnd = toTime(aTo, FAR_FUTURE)
  const bStart = toTime(bFrom, "1970-01-01")
  const bEnd = toTime(bTo, FAR_FUTURE)
  return aStart <= bEnd && bStart <= aEnd
}

function resourceKey(row: { resource_id: string | null; resource_name: string | null }) {
  return (row.resource_id != null && String(row.resource_id).trim() !== "" ? `id:${row.resource_id}` : null) ??
    (row.resource_name ? `name:${row.resource_name.trim().toLowerCase()}` : "unknown")
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
  return Number.isFinite(parsed) ? parsed : 0
}

// Core detection: given a set of allocations plus approved leaves, produce the
// list of conflicts. A `candidate` allocation (not yet saved) can be included
// so callers can preview conflicts before committing a new allocation.
function detectConflicts(allocations: AllocationRow[], leaves: LeaveRow[], candidate?: AllocationRow): Conflict[] {
  const conflicts: Conflict[] = []
  const rows = candidate ? [...allocations, candidate] : allocations
  const isCandidate = (row: AllocationRow) => candidate != null && row === candidate

  // Group by resource for over-allocation + overlap detection.
  const byResource = new Map<string, AllocationRow[]>()
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

async function loadData(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  const scoped = await scopeWhereForModule(session, "operations.allocations", "view", "operations_allocations")
  const { where, args } = mergeScopeIntoWhere("", [], scoped)
  const statusList = ACTIVE_ALLOCATION_STATUSES.map(() => "?").join(",")
  const allocWhere = where ? `${where} AND status IN (${statusList})` : `WHERE status IN (${statusList})`
  const allocations = await query<AllocationRow[]>(
    `SELECT * FROM operations_allocations ${allocWhere}`,
    [...args, ...ACTIVE_ALLOCATION_STATUSES],
  )
  const leaveStatusList = APPROVED_LEAVE_STATUSES.map(() => "?").join(",")
  const leaves = await query<LeaveRow[]>(
    `SELECT employee_id, employee_name, from_date, to_date, status FROM hr_leave_requests WHERE status IN (${leaveStatusList})`,
    APPROVED_LEAVE_STATUSES,
  )
  return { allocations, leaves }
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const { allocations, leaves } = await loadData(session)
    const conflicts = detectConflicts(allocations, leaves)
    const summary = {
      total: conflicts.length,
      over_allocation: conflicts.filter((c) => c.type === "over_allocation").length,
      overlap: conflicts.filter((c) => c.type === "overlap").length,
      capacity_exceeded: conflicts.filter((c) => c.type === "capacity_exceeded").length,
      on_leave: conflicts.filter((c) => c.type === "on_leave").length,
      analyzed_allocations: allocations.length,
    }
    return NextResponse.json({ conflicts, summary })
  } catch {
    return NextResponse.json({ error: "Failed to analyze resource conflicts" }, { status: 500 })
  }
}

// Pre-save check: caller supplies a candidate allocation and receives the
// conflicts it would introduce, so the UI can warn before the allocation is
// actually created in the Allocations module.
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await request.json()
    const candidate: AllocationRow = {
      resource_id: body.resource_id ?? null,
      resource_name: body.resource_name ?? null,
      project_id: body.project_id ?? null,
      client_name: body.client_name ?? null,
      role: body.role ?? null,
      allocation_percent: body.allocation_percent != null ? num(body.allocation_percent) : null,
      from_date: body.from_date ?? null,
      to_date: body.to_date ?? null,
      working_capacity: body.working_capacity != null ? num(body.working_capacity) : null,
      allocated_capacity: body.allocated_capacity != null ? num(body.allocated_capacity) : null,
      status: body.status ?? "Active",
    }
    if (!candidate.resource_id && !candidate.resource_name) {
      return NextResponse.json({ error: "A resource is required to check for conflicts" }, { status: 400 })
    }
    const { allocations, leaves } = await loadData(session)
    // Exclude the row being edited (if any) so a record does not conflict with itself.
    const editingId = body.exclude_id != null ? String(body.exclude_id) : null
    const others = editingId
      ? allocations.filter((a) => String(a.allocation_id ?? a.id ?? "") !== editingId)
      : allocations
    const conflicts = detectConflicts(others, leaves, candidate).filter((c) => c.related.includes(candidate as Record<string, unknown>))
    return NextResponse.json({ conflicts, hasConflicts: conflicts.length > 0 })
  } catch {
    return NextResponse.json({ error: "Failed to check allocation conflicts" }, { status: 500 })
  }
}
