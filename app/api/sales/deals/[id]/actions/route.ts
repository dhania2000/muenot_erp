import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  winDeal,
  loseDeal,
  reopenDeal,
  requestApproval,
  decideApproval,
  DealNotFoundError,
  DealValidationError,
} from "@/lib/sales/deal-pipeline"

/**
 * Lifecycle actions for a deal: win / lose / reopen and the approval workflow
 * (request / approve / reject). Approve & reject require the "approve_deals"
 * capability; everything else requires manage.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const dealId = Number(id)
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")

  const needsApprovalRight = action === "approve" || action === "reject"
  const session = await requireFeature(needsApprovalRight ? "sales.approve_deals" : "sales.manage_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    switch (action) {
      case "win":
        await winDeal(dealId, { value: body.value ?? null, note: body.note ?? null }, session.userId)
        break
      case "lose":
        if (!body.reason) return NextResponse.json({ error: "A lost reason is required" }, { status: 400 })
        await loseDeal(dealId, { reason: String(body.reason), note: body.note ?? null }, session.userId)
        break
      case "reopen":
        await reopenDeal(dealId, session.userId)
        break
      case "request_approval":
        await requestApproval(dealId, body.note ?? null, session.userId)
        break
      case "approve":
        await decideApproval(dealId, "Approved", body.note ?? null, session.userId)
        break
      case "reject":
        await decideApproval(dealId, "Rejected", body.note ?? null, session.userId)
        break
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof DealNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    if (error instanceof DealValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error("[deals] action failed", error)
    return NextResponse.json({ error: "Unable to complete action." }, { status: 500 })
  }
}
