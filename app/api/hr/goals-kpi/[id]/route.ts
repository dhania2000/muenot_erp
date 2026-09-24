import { NextResponse } from "next/server"
import { requireFeature, getTenantId } from "@/lib/api-auth"
import { computeKpi } from "@/lib/goals-kpi/calc"
import {
  deleteGoal,
  getGoal,
  setLifecycle,
  updateGoal,
  ValidationError,
  type GoalInput,
} from "@/lib/goals-kpi/store"
import { type KpiLifecycle } from "@/lib/goals-kpi/config"

/**
 * SPEC 135 — Goal / KPI Engine · single-goal endpoint.
 *   GET    → one computed goal.
 *   PATCH  → update fields, or flip lifecycle via `{ lifecycle }`.
 *   DELETE → permanently remove the goal and its check-ins.
 */

async function resolveId(context: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await context.params
  return Number(id)
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.view_goals_kpi")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "No tenant" }, { status: 403 })

  const goal = await getGoal(tenantId, await resolveId(context))
  if (!goal) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ goal: computeKpi(goal) })
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_goals_kpi")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "No tenant" }, { status: 403 })

  const id = await resolveId(context)
  const body = (await request.json().catch(() => ({}))) as Partial<GoalInput> & { lifecycle?: KpiLifecycle }

  try {
    if (body.lifecycle && (body.lifecycle === "active" || body.lifecycle === "archived")) {
      const ok = await setLifecycle(tenantId, id, body.lifecycle)
      if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
      return NextResponse.json({ ok: true })
    }
    const ok = await updateGoal(tenantId, id, body)
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const goal = await getGoal(tenantId, id)
    return NextResponse.json({ ok: true, goal: goal ? computeKpi(goal) : null })
  } catch (error) {
    if (error instanceof ValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_goals_kpi")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "No tenant" }, { status: 403 })

  const ok = await deleteGoal(tenantId, await resolveId(context))
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
