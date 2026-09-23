import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { deleteRatePolicy, RatePolicyError, updateRatePolicy } from "@/lib/api-platform/rate-limit-policies"

export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

async function authorized(context: Context): Promise<
  { ok: false; response: NextResponse } | { ok: true; tenantId: number; id: number; actorId: number }
> {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return { ok: false, response: NextResponse.json({ error: guard.reason }, { status: guard.status }) }
  const tenantId = effectiveTenantId(guard.ctx)
  const id = Number((await context.params).id)
  if (!tenantId || !Number.isSafeInteger(id) || id <= 0) return { ok: false, response: NextResponse.json({ error: "Invalid policy ID" }, { status: 400 }) }
  return { ok: true, tenantId, id, actorId: guard.ctx.userId }
}

export async function PATCH(request: Request, context: Context) {
  const ctx = await authorized(context)
  if (!ctx.ok) return ctx.response
  try {
    const value: unknown = await request.json()
    return NextResponse.json({ policy: await updateRatePolicy(ctx.tenantId, ctx.id, value, ctx.actorId) })
  } catch (error) {
    if (error instanceof RatePolicyError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    return NextResponse.json({ error: "Unable to update policy" }, { status: 500 })
  }
}

export async function DELETE(_request: Request, context: Context) {
  const ctx = await authorized(context)
  if (!ctx.ok) return ctx.response
  try { await deleteRatePolicy(ctx.tenantId, ctx.id, ctx.actorId); return NextResponse.json({ deleted: true }) }
  catch (error) {
    if (error instanceof RatePolicyError) return NextResponse.json({ error: error.message }, { status: error.status })
    return NextResponse.json({ error: "Unable to delete policy" }, { status: 500 })
  }
}
