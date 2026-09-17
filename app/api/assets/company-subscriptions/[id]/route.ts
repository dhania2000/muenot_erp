import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  getSubscriptionDetail,
  updateSubscription,
  deleteSubscription,
  renewSubscription,
  cancelSubscription,
  suspendSubscription,
  reactivateSubscription,
  SubscriptionError,
} from "@/lib/company-subscriptions"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await requireFeature("assets.view_company_subscriptions")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await ctx.params
  const detail = await getSubscriptionDetail(id)
  if (!detail) return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  return NextResponse.json(detail)
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || "update")

  const gate: Record<string, string> = {
    update: "update",
    renew: "renew",
    cancel: "cancel",
    suspend: "cancel",
    reactivate: "cancel",
  }
  const actionKey = gate[action]
  if (!actionKey) return NextResponse.json({ error: "Unknown action" }, { status: 400 })

  const session = await requireModuleAction("assets.company_subscriptions", actionKey)
  if (!session) return NextResponse.json({ error: "You do not have permission for this action." }, { status: 403 })

  try {
    let detail
    switch (action) {
      case "renew":
        detail = await renewSubscription(id, body, session)
        break
      case "cancel":
        detail = await cancelSubscription(id, body, session)
        break
      case "suspend":
        detail = await suspendSubscription(id, body, session)
        break
      case "reactivate":
        detail = await reactivateSubscription(id, body, session)
        break
      default:
        detail = await updateSubscription(id, body, session)
    }
    return NextResponse.json(detail)
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] subscription action failed", (error as Error).message)
    return NextResponse.json({ error: "Action failed." }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await requireModuleAction("assets.company_subscriptions", "delete")
  if (!session) return NextResponse.json({ error: "You do not have permission to delete." }, { status: 403 })
  const { id } = await ctx.params
  try {
    await deleteSubscription(id, session)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] delete subscription failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to delete subscription." }, { status: 500 })
  }
}
