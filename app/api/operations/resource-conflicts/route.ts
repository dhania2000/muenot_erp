import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canPerformAction } from "@/lib/permission-enforce"
import { acceptedConflictKeys, loadConflictData } from "@/lib/resource-conflicts"
import { allocationId, detectConflicts, num, type AllocationRow } from "@/lib/resource-conflicts-model"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canPerformAction(session, "operations.allocations", "view"))) {
    return NextResponse.json({ error: "You do not have permission to view allocations." }, { status: 403 })
  }
  try {
    const { allocations, leaves } = await loadConflictData(session)
    const accepted = await acceptedConflictKeys().catch(() => new Set<string>())
    const all = detectConflicts(allocations, leaves).map((c) => ({ ...c, accepted: accepted.has(c.key) }))
    const open = all.filter((c) => !c.accepted)
    const summary = {
      total: open.length,
      accepted: all.length - open.length,
      over_allocation: open.filter((c) => c.type === "over_allocation").length,
      overlap: open.filter((c) => c.type === "overlap").length,
      capacity_exceeded: open.filter((c) => c.type === "capacity_exceeded").length,
      on_leave: open.filter((c) => c.type === "on_leave").length,
      analyzed_allocations: allocations.length,
    }
    return NextResponse.json({ conflicts: all, summary })
  } catch {
    return NextResponse.json({ error: "Failed to analyze resource conflicts" }, { status: 500 })
  }
}

// Pre-save check: returns the conflicts a candidate allocation would introduce.
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canPerformAction(session, "operations.allocations", "view"))) {
    return NextResponse.json({ error: "You do not have permission to view allocations." }, { status: 403 })
  }
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const candidate: AllocationRow = {
    resource_id: body?.resource_id ?? null,
    resource_name: body?.resource_name ?? null,
    project_id: body?.project_id ?? null,
    client_name: body?.client_name ?? null,
    role: body?.role ?? null,
    allocation_percent: body?.allocation_percent != null ? num(body.allocation_percent) : null,
    from_date: body?.from_date ?? null,
    to_date: body?.to_date ?? null,
    working_capacity: body?.working_capacity != null ? num(body.working_capacity) : null,
    allocated_capacity: body?.allocated_capacity != null ? num(body.allocated_capacity) : null,
    status: body?.status ?? "Active",
  }
  if (!candidate.resource_id && !candidate.resource_name) {
    return NextResponse.json({ error: "A resource is required to check for conflicts" }, { status: 400 })
  }
  try {
    const { allocations, leaves } = await loadConflictData(session)
    const editingId = body.exclude_id != null ? String(body.exclude_id) : null
    const others = editingId ? allocations.filter((a) => allocationId(a) !== editingId) : allocations
    const conflicts = detectConflicts(others, leaves, candidate).filter((c) =>
      c.related.includes(candidate as Record<string, unknown>),
    )
    return NextResponse.json({ conflicts, hasConflicts: conflicts.length > 0 })
  } catch {
    return NextResponse.json({ error: "Failed to check allocation conflicts" }, { status: 500 })
  }
}
