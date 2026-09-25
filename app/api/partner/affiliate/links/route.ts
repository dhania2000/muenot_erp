import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"
import { validateLinkInput } from "@/lib/affiliates/model"
import { createLink, resolveAffiliate } from "@/lib/affiliates/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

/** Affiliate creates a tracked link for THEIR OWN partner (any body partnerId is ignored). */
export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    const partnerId = await resolveAffiliate(session.userId)
    const { label } = validateLinkInput(await readJson(req))
    const result = await createLink({
      partnerId,
      label,
      actorUserId: session.userId,
      idempotencyKey: normalizeIdempotencyKey(req.headers.get("idempotency-key")),
    })
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: session.userId,
        actorEmail: session.email,
        action: "affiliate_link_created",
        detail: { partnerId, linkId: result.link.id, by: "affiliate" },
      })
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to create link")
  }
}
