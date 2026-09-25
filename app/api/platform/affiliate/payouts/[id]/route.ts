import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { validatePayoutAction } from "@/lib/affiliates/model"
import { transitionPayout } from "@/lib/affiliates/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/** Body: { action: "mark_paid", reference } | { action: "void", reason }. */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const payoutId = positiveId((await params).id)
    if (!payoutId) throw new PartnerError("Invalid payout id", "INVALID_ID")
    const input = validatePayoutAction(await readJson(req))
    const result = await transitionPayout({ payoutId, ...input, actorUserId: guard.ctx.userId })
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: input.action === "mark_paid" ? "affiliate_payout_paid" : "affiliate_payout_voided",
        detail: {
          payoutId,
          partnerId: result.payout.partnerId,
          amount: result.payout.amount,
          currency: result.payout.currency,
          from: result.previousStatus,
          reference: input.reference,
          reason: input.reason,
        },
      })
    }
    return NextResponse.json(result)
  } catch (err) {
    return partnerErrorResponse(err, "Failed to update payout")
  }
}
