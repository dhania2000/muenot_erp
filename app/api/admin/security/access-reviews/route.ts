import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { isFrequency, isReviewSubjectType } from "@/lib/access-review-core"
import {
  AccessReviewError,
  createCampaign,
  getAuditTrail,
  listCampaigns,
} from "@/lib/access-review-store"

export const dynamic = "force-dynamic"

/** GET → every access-review campaign for the tenant + recent audit trail. */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const [campaigns, audit] = await Promise.all([listCampaigns(tenantId), getAuditTrail(tenantId)])
  return NextResponse.json({ campaigns, audit })
}

/** POST → launch a new review campaign, snapshotting the selected access types. */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const scopeTypes = Array.isArray(body?.scopeTypes) ? body.scopeTypes.filter(isReviewSubjectType) : []
  const frequency = isFrequency(body?.frequency) ? body.frequency : "once"

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const campaign = await createCampaign(tenantId, actor, {
      name: String(body?.name ?? ""),
      description: body?.description ?? null,
      scopeTypes,
      frequency,
      dueInDays: body?.dueInDays != null ? Number(body.dueInDays) : undefined,
    })
    return NextResponse.json({ ok: true, campaign })
  } catch (err) {
    if (err instanceof AccessReviewError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/security/access-reviews] create failed:", err)
    return NextResponse.json({ error: "Failed to create access review" }, { status: 500 })
  }
}
