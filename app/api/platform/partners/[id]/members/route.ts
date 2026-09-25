import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { PartnerError, positiveId } from "@/lib/partners/model"
import { addMember, revokeMember } from "@/lib/partners/store"
import { partnerErrorResponse, readJson } from "@/lib/partners/http"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

async function parse(req: Request, params: Ctx["params"]) {
  const partnerId = positiveId((await params).id)
  if (!partnerId) throw new PartnerError("Invalid partner id", "INVALID_ID")
  const userId = positiveId((await readJson(req))?.userId)
  if (!userId) throw new PartnerError("userId must be a positive integer", "INVALID_ID")
  return { partnerId, userId }
}

/** Grant a user partner-dashboard access (no ERP/tenant role is granted). */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const { partnerId, userId } = await parse(req, params)
    await addMember(partnerId, userId, guard.ctx.userId)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "partner_member_granted",
      targetUserId: userId,
      detail: { partnerId },
    })
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to add partner member")
  }
}

/** Revoke a member's dashboard access. */
export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const { partnerId, userId } = await parse(req, params)
    const { revoked } = await revokeMember(partnerId, userId, guard.ctx.userId)
    if (revoked) {
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "partner_member_revoked",
        targetUserId: userId,
        detail: { partnerId },
      })
    }
    return NextResponse.json({ ok: true, revoked })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to revoke partner member")
  }
}
