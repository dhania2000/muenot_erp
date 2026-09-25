import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { cancelReferral } from "@/lib/partners/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/** Cancel an attribution. Body: { reason }. Settled commissions are kept. */
export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const referralId = positiveId((await params).id)
    if (!referralId) throw new PartnerError("Invalid referral id", "INVALID_ID")
    const reason = String((await readJson(req))?.reason ?? "").trim()
    if (reason.length < 3 || reason.length > 300) throw new PartnerError("reason must be 3-300 characters", "INVALID_REASON")
    const { referral, replayed } = await cancelReferral(referralId, reason, guard.ctx.userId)
    if (!replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "partner_referral_cancelled",
        targetTenantId: referral.tenantId,
        detail: { referralId, partnerId: referral.partnerId, reason },
      })
    }
    return NextResponse.json({ referral, replayed })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to cancel referral")
  }
}
