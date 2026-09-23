import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { applyReviewDecision, createAccessReviewCampaign, decideAccessReviewItem, listAccessReviewCampaigns, listReviewableUsers, type ReviewDecision } from "@/lib/access-review-store"

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requireTenantAdmin(); if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx); if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  try { return NextResponse.json({ campaigns: await listAccessReviewCampaigns(tenantId), users: await listReviewableUsers(tenantId) }) } catch (error) { console.error("[access-reviews] list failed", error); return NextResponse.json({ error: "Unable to load access reviews" }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin(); if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx); if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  try {
    const body = await req.json()
    const id = await createAccessReviewCampaign(tenantId, guard.session, { name: String(body.name ?? ""), reviewerId: Number(body.reviewerId), startAt: String(body.startAt ?? ""), dueAt: String(body.dueAt ?? ""), recurrence: String(body.recurrence ?? "one_time"), items: Array.isArray(body.items) ? body.items : [] })
    return NextResponse.json({ ok: true, id }, { status: 201 })
  } catch (error) { const message = error instanceof Error ? error.message : "Unable to create access review"; return NextResponse.json({ error: message }, { status: 400 }) }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireTenantAdmin(); if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx); if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  try {
    const body = await req.json(); const decision = String(body.decision) as ReviewDecision
    if (!["approved", "revoked", "remediated"].includes(decision)) return NextResponse.json({ error: "Invalid review decision" }, { status: 400 })
    await decideAccessReviewItem(tenantId, guard.session, Number(body.itemId), decision as Exclude<ReviewDecision, "pending">, body.comment)
    await applyReviewDecision(tenantId, Number(body.itemId), decision)
    return NextResponse.json({ ok: true })
  } catch (error) { const message = error instanceof Error ? error.message : "Unable to update review"; return NextResponse.json({ error: message }, { status: 400 }) }
}
