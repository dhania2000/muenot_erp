import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { upsertPlan, setPlanActive } from "@/lib/platform-console"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * SPEC 4 — Plan catalog management. Creating/editing plans and (de)activating
 * them shapes what every tenant can be billed, so it is super-admin only.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    await upsertPlan({
      code: String(body?.code ?? ""),
      name: String(body?.name ?? ""),
      description: body?.description != null ? String(body.description) : null,
      price_monthly: Number(body?.price_monthly),
      currency: body?.currency ? String(body.currency) : undefined,
      seat_limit: body?.seat_limit != null && body.seat_limit !== "" ? Number(body.seat_limit) : null,
      features: Array.isArray(body?.features) ? body.features.map(String) : [],
      sort_order: body?.sort_order != null ? Number(body.sort_order) : 0,
    })
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "plan_upsert",
      detail: { code: String(body?.code ?? "") },
    })
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to save plan" }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const code = body?.code ? String(body.code) : ""
  if (!code) return NextResponse.json({ error: "Plan code is required" }, { status: 400 })
  if (typeof body?.active !== "boolean") {
    return NextResponse.json({ error: "`active` must be a boolean" }, { status: 400 })
  }

  try {
    await setPlanActive(code, body.active)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "plan_active_change",
      detail: { code, active: body.active },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to update plan" }, { status: 400 })
  }
}
