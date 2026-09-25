import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { validateLinkStatus } from "@/lib/affiliates/model"
import { setLinkStatus } from "@/lib/affiliates/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/** Platform enable/disable of any affiliate link (e.g. on suspected fraud). */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const linkId = positiveId((await params).id)
    if (!linkId) throw new PartnerError("Invalid link id", "INVALID_ID")
    const status = validateLinkStatus((await readJson(req))?.status)
    const result = await setLinkStatus(linkId, status, null)
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "affiliate_link_status_changed",
        detail: { partnerId: result.link.partnerId, linkId, from: result.previous, to: status, by: "platform" },
      })
    }
    return NextResponse.json(result)
  } catch (err) {
    return partnerErrorResponse(err, "Failed to update link")
  }
}
