import { NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { validateCurrency } from "@/lib/affiliates/model"
import { createPayout, listPayouts } from "@/lib/affiliates/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const raw = new URL(req.url).searchParams.get("partnerId")
    const partnerId = raw == null ? null : positiveId(raw)
    if (raw != null && !partnerId) throw new PartnerError("Invalid partner id", "INVALID_ID")
    return NextResponse.json({ payouts: await listPayouts(partnerId) }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to list payouts")
  }
}

/**
 * Create a pending payout of a partner's available balance in one currency.
 * Idempotency-Key header is REQUIRED (money movement). Body: { partnerId, currency? }.
 */
export async function POST(req: Request) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"))
    if (!idempotencyKey) throw new PartnerError("A valid Idempotency-Key header is required", "IDEMPOTENCY_KEY_REQUIRED", 400)
    const body = await readJson(req)
    const partnerId = positiveId(body?.partnerId)
    if (!partnerId) throw new PartnerError("partnerId must be a positive integer", "INVALID_ID")
    const currency = validateCurrency(body?.currency)
    const result = await createPayout({ partnerId, currency, actorUserId: guard.ctx.userId, idempotencyKey })
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "affiliate_payout_created",
        detail: { partnerId, payoutId: result.payout.id, amount: result.payout.amount, currency, entries: result.entries },
      })
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to create payout")
  }
}
