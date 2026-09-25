import { NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { getPartner } from "@/lib/partners/store"
import { validateLinkInput } from "@/lib/affiliates/model"
import { createLink, listLinks, listPayouts, partnerBalances, syncConversions } from "@/lib/affiliates/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

async function partnerIdFrom(params: Ctx["params"]) {
  const id = positiveId((await params).id)
  if (!id) throw new PartnerError("Invalid partner id", "INVALID_ID")
  return id
}

/** Staff view of a partner's affiliate links, balances and payouts. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const partnerId = await partnerIdFrom(params)
    const partner = await getPartner(partnerId)
    await syncConversions(partnerId, new Date())
    const [links, balances, payouts] = await Promise.all([
      listLinks(partnerId),
      partnerBalances(partnerId, partner.terms.revenueShareBps),
      listPayouts(partnerId),
    ])
    return NextResponse.json({ links, balances, payouts }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to load affiliate data")
  }
}

/** Create a tracked link for a partner. Optional Idempotency-Key header. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const partnerId = await partnerIdFrom(params)
    const { label } = validateLinkInput(await readJson(req))
    const result = await createLink({
      partnerId,
      label,
      actorUserId: guard.ctx.userId,
      idempotencyKey: normalizeIdempotencyKey(req.headers.get("idempotency-key")),
    })
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "affiliate_link_created",
        detail: { partnerId, linkId: result.link.id, by: "platform" },
      })
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to create link")
  }
}
