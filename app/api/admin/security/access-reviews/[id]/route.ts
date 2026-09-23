import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { AccessReviewError, cancelCampaign, getAuditTrail, getCampaign } from "@/lib/access-review-store"

export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** GET → one campaign with its items and its own audit trail. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })

  const found = await getCampaign(tenantId, id)
  if (!found) return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
  const audit = await getAuditTrail(tenantId, id)
  return NextResponse.json({ campaign: found.campaign, items: found.items, audit })
}

/** PATCH → cancel an active campaign (the only mutation on the campaign itself). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  if (body?.action !== "cancel") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  }

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    await cancelCampaign(tenantId, actor, id)
    const found = await getCampaign(tenantId, id)
    return NextResponse.json({ ok: true, campaign: found?.campaign })
  } catch (err) {
    if (err instanceof AccessReviewError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/security/access-reviews] cancel failed:", err)
    return NextResponse.json({ error: "Failed to cancel campaign" }, { status: 500 })
  }
}
