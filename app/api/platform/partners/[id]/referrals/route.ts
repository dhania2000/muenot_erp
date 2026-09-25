import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { OWNERSHIPS, PartnerError, positiveId, type Ownership } from "@/lib/partners/model"
import { attributeTenant } from "@/lib/partners/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/**
 * Attribute a customer tenant to this partner. Body: { tenantId, ownership?,
 * transfer? }. Moving a tenant away from another partner needs transfer=true.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const partnerId = positiveId((await params).id)
    if (!partnerId) throw new PartnerError("Invalid partner id", "INVALID_ID")
    const body = await readJson(req)
    const tenantId = positiveId(body?.tenantId)
    if (!tenantId) throw new PartnerError("tenantId must be a positive integer", "INVALID_ID")
    const ownership: Ownership = body?.ownership ?? "platform"
    if (!OWNERSHIPS.includes(ownership)) throw new PartnerError("ownership must be platform or partner", "INVALID_OWNERSHIP")
    const result = await attributeTenant({
      partnerId,
      tenantId,
      ownership,
      transfer: body?.transfer === true,
      actorUserId: guard.ctx.userId,
    })
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: result.previous ? "partner_referral_transferred" : "partner_referral_attributed",
        targetTenantId: tenantId,
        detail: { partnerId, referralId: result.referral.id, ownership, fromPartnerId: result.previous?.partnerId ?? null },
      })
    }
    return NextResponse.json(
      { referral: result.referral, replayed: result.replayed },
      { status: result.replayed ? 200 : 201 },
    )
  } catch (err) {
    return partnerErrorResponse(err, "Failed to attribute tenant")
  }
}
