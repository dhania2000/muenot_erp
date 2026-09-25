import { NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { CustomerSuccessError } from "@/lib/customer-success/model"
import { computeSnapshot, getTenantHealth, tenantExists } from "@/lib/customer-success/store"
import { NO_STORE, csErrorResponse } from "@/lib/customer-success/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ tenantId: string }> }

async function resolveTenant(ctx: Ctx): Promise<number> {
  const { tenantId: raw } = await ctx.params
  const tenantId = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(tenantId) || tenantId < 1) {
    throw new CustomerSuccessError("tenantId must be a positive integer", "INVALID_ID")
  }
  if (!(await tenantExists(tenantId))) throw new CustomerSuccessError("Tenant not found", "NOT_FOUND", 404)
  return tenantId
}

/** Health detail for one tenant: factors, risks, trend, module usage (aggregates only). */
export async function GET(_req: Request, ctx: Ctx) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status, headers: NO_STORE })
  try {
    const tenantId = await resolveTenant(ctx)
    return NextResponse.json(await getTenantHealth(tenantId), { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to load tenant health")
  }
}

/** Recompute today's snapshot. Idempotent: the daily snapshot is upserted, never duplicated. */
export async function POST(_req: Request, ctx: Ctx) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status, headers: NO_STORE })
  try {
    const tenantId = await resolveTenant(ctx)
    const snapshot = await computeSnapshot(tenantId)
    await recordPlatformAudit({
      actorUserId: guard.session.userId,
      actorEmail: guard.session.email,
      action: "customer_success_recomputed",
      targetTenantId: tenantId,
      detail: { score: snapshot.score, band: snapshot.band, date: snapshot.date },
    })
    return NextResponse.json({ snapshot }, { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to recompute tenant health")
  }
}
