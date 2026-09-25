import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { validateLinkStatus } from "@/lib/affiliates/model"
import { resolveAffiliate, setLinkStatus } from "@/lib/affiliates/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

/** Enable/disable one of the caller's own links; others' links are 404. */
export async function PATCH(req: Request, { params }: Ctx) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    const partnerId = await resolveAffiliate(session.userId)
    const linkId = positiveId((await params).id)
    if (!linkId) throw new PartnerError("Invalid link id", "INVALID_ID")
    const status = validateLinkStatus((await readJson(req))?.status)
    const result = await setLinkStatus(linkId, status, partnerId)
    if (!result.replayed) {
      await recordPlatformAudit({
        actorUserId: session.userId,
        actorEmail: session.email,
        action: "affiliate_link_status_changed",
        detail: { partnerId, linkId, from: result.previous, to: status, by: "affiliate" },
      })
    }
    return NextResponse.json(result)
  } catch (err) {
    return partnerErrorResponse(err, "Failed to update link")
  }
}
