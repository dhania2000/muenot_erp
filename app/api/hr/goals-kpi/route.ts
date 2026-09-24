import { NextResponse } from "next/server"
import { requireFeature, getTenantId } from "@/lib/api-auth"
import { userHasFeature } from "@/lib/permissions"
import { createGoal, listComputed, ValidationError, type GoalInput } from "@/lib/goals-kpi/store"

/**
 * SPEC 135 — Goal / KPI Engine · collection endpoint.
 *   GET  → computed goals + summary/per-scope roll-ups for the acting tenant.
 *   POST → create a new KPI definition (requires manage permission).
 */

export async function GET(request: Request) {
  const session = await requireFeature("hr.view_goals_kpi")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "No tenant" }, { status: 403 })

  const sp = new URL(request.url).searchParams
  const { goals, summary, byScope } = await listComputed(tenantId, {
    scope: sp.get("scope") || undefined,
    lifecycle: (sp.get("lifecycle") as any) || "active",
    search: sp.get("q") || undefined,
  })

  const canManage = await userHasFeature(session.userId, session.role, "hr.manage_goals_kpi")
  return NextResponse.json({ goals, summary, byScope, canManage })
}

export async function POST(request: Request) {
  const session = await requireFeature("hr.manage_goals_kpi")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "No tenant" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as GoalInput
  try {
    const id = await createGoal(tenantId, body, session.userId)
    return NextResponse.json({ ok: true, id }, { status: 201 })
  } catch (error) {
    if (error instanceof ValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  }
}
