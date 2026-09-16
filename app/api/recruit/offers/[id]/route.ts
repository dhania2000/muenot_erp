import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getOfferById, updateOffer, deleteOffer } from "@/lib/recruit-db"
import { canActOnRecord, canActOnRecordAction } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"
import { syncOfferStatus } from "@/lib/recruit-status-sync"

const PERMISSION_KEY = "recruitment.offers"
const AUDIT_MODULE = "recruit-offers"

const SEND_STATUSES = new Set(["sent", "released", "issued", "extended"])
const REVOKE_STATUSES = new Set(["revoked", "withdrawn", "rescinded", "cancelled", "canceled"])

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getOfferById(id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json()

  // Phase 53: issuing or revoking an offer is gated separately from a plain
  // Update, so a mere Update can neither release nor rescind a live offer.
  // Unconfigured / admin accounts fall through to full access.
  const oldStatus = String(existing.status ?? "").trim().toLowerCase()
  const newStatus = String(body.status ?? existing.status ?? "").trim().toLowerCase()
  let extraAction: string | null = null
  if (SEND_STATUSES.has(newStatus) && !SEND_STATUSES.has(oldStatus)) extraAction = "send_offer"
  else if (REVOKE_STATUSES.has(newStatus) && !REVOKE_STATUSES.has(oldStatus)) extraAction = "revoke_offer"

  if (extraAction) {
    if (!(await canActOnRecordAction(session, PERMISSION_KEY, extraAction, existing))) {
      const label = extraAction === "send_offer" ? "send" : "revoke"
      return NextResponse.json(
        { error: `You do not have permission to ${label} this offer` },
        { status: 403 },
      )
    }
  } else if (!(await canActOnRecord(session, PERMISSION_KEY, "update", existing))) {
    return NextResponse.json({ error: "You do not have permission to edit this offer" }, { status: 403 })
  }

  await updateOffer(id, body)
  const after = await getOfferById(id)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_offers",
    recordId: id,
    action: "update",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
    newValue: after ?? body,
  })

  // Phase 56: an offer accept/decline moves the linked application (and the
  // Candidate Master + Requisition headcount) with it.
  if (body.status && String(existing.status) !== String(after?.status ?? body.status)) {
    await syncOfferStatus({
      offerId: id,
      status: after?.status ?? body.status,
      actor: { actorId: session.userId, actorName: session.name },
    })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getOfferById(id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "delete", existing))) {
    return NextResponse.json({ error: "You do not have permission to delete this offer" }, { status: 403 })
  }

  await deleteOffer(id)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_offers",
    recordId: id,
    action: "delete",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
  })
  return NextResponse.json({ ok: true })
}
