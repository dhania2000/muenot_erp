import { NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"
import { validatePartnerInput } from "@/lib/partners/model"
import { createPartner, listPartners } from "@/lib/partners/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

/** List partners (platform staff). */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json({ partners: await listPartners() })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to load partners")
  }
}

/** Create a partner with contract terms (super admin). Idempotency-Key honored. */
export async function POST(req: Request) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const input = validatePartnerInput(await readJson(req))
    const { partner, replayed } = await createPartner(
      input,
      guard.ctx.userId,
      normalizeIdempotencyKey(req.headers.get("idempotency-key")),
    )
    if (!replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "partner_created",
        detail: { partnerId: partner.id, kind: partner.kind, terms: partner.terms },
      })
    }
    return NextResponse.json({ partner, replayed }, { status: replayed ? 200 : 201 })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to create partner")
  }
}
