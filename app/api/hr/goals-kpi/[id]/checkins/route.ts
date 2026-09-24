import { NextResponse } from "next/server"
import { requireFeature, getTenantId } from "@/lib/api-auth"
import { addCheckin, listCheckins, ValidationError } from "@/lib/goals-kpi/store"

/**
 * SPEC 135 — Goal / KPI Engine · progress check-ins.
 *   GET  → the append-only check-in history for a goal.
 *   POST → record a new actual value (mirrors onto the goal, recomputes health).
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

  const checkins = await listCheckins(tenantId, await resolveId(context))
  return NextResponse.json({ checkins })
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_goals_kpi")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "No tenant" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { actual_value?: number; note?: string | null }
  if (body.actual_value == null) return NextResponse.json({ error: "Actual value is required." }, { status: 400 })

  try {
    const result = await addCheckin(tenantId, await resolveId(context), Number(body.actual_value), body.note ?? null, session.userId)
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (error) {
    if (error instanceof ValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  }
}
