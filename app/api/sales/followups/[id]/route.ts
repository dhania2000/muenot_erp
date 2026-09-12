import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { completeFollowUp, cancelFollowUp, LeadNotFoundError } from "@/lib/sales/lead-lifecycle"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  try {
    if (body.action === "cancel") {
      await cancelFollowUp(Number(id), session.userId)
    } else {
      await completeFollowUp(
        Number(id),
        { outcome: body.outcome || null, nextStage: body.next_stage || null },
        session.userId,
      )
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof LeadNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[followup-update] failed", error)
    return NextResponse.json({ error: "Unable to update follow-up" }, { status: 500 })
  }
}
