import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { dayOf } from "@/lib/partners/model"
import { settleCommissions } from "@/lib/partners/store"
import { partnerErrorResponse } from "@/lib/partners/http"

export const runtime = "nodejs"

/**
 * Run commission settlement. Safe to repeat: each invoice settles at most once.
 * The settlement day is always the server's current date (never client input),
 * so a caller cannot shortcut the refund window.
 */
export async function POST() {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const result = await settleCommissions(dayOf(new Date())!, guard.ctx.userId)
    if (result.settled.length) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "partner_commissions_settled",
        detail: { settled: result.settled },
      })
    }
    return NextResponse.json(result)
  } catch (err) {
    return partnerErrorResponse(err, "Failed to settle commissions")
  }
}
