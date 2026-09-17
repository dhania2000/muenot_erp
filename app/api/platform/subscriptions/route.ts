import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { changeSubscriptionPlan, setSubscriptionStatus, type SubscriptionStatus } from "@/lib/platform-console"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * SPEC 4 — Change a tenant's subscription: switch plan and/or set status.
 * Platform-staff surface; audited. Plan/price is resolved server-side from the
 * plan record so the MRR can never be spoofed by the client.
 */
const STATUSES: SubscriptionStatus[] = ["trialing", "active", "past_due", "canceled"]

export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const tenantId = Number(body?.tenantId)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "Invalid tenant id" }, { status: 400 })
  }

  const planCode = body?.planCode != null ? String(body.planCode) : null
  const status = body?.status != null ? String(body.status) : null
  if (!planCode && !status) {
    return NextResponse.json({ error: "Provide planCode and/or status" }, { status: 400 })
  }
  if (status && !STATUSES.includes(status as SubscriptionStatus)) {
    return NextResponse.json({ error: "Invalid subscription status" }, { status: 400 })
  }

  try {
    if (planCode) await changeSubscriptionPlan(tenantId, planCode)
    if (status) await setSubscriptionStatus(tenantId, status as SubscriptionStatus)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "subscription_change",
      targetTenantId: tenantId,
      detail: { planCode, status },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to update subscription" }, { status: 400 })
  }
}
