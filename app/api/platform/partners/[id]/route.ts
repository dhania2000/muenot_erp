import { NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { getPartnerDetail, updatePartner } from "@/lib/partners/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = positiveId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid partner id" }, { status: 400 })
  try {
    return NextResponse.json(await getPartnerDetail(id))
  } catch (err) {
    return partnerErrorResponse(err, "Failed to load partner")
  }
}

/** Change status (active/suspended/terminated) and/or contract terms. */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = positiveId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid partner id" }, { status: 400 })
  try {
    const body = await readJson(req)
    if (body?.status === undefined && body?.terms === undefined) {
      throw new PartnerError("Provide status and/or terms", "INVALID_PATCH")
    }
    const { before, after } = await updatePartner(id, { status: body.status, terms: body.terms }, guard.ctx.userId)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: before.status !== after.status ? `partner_${after.status}` : "partner_terms_updated",
      detail: { partnerId: id, before: { status: before.status, terms: before.terms }, after: { status: after.status, terms: after.terms } },
    })
    return NextResponse.json({ partner: after })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to update partner")
  }
}
