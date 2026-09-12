import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { reopenLead, LeadNotFoundError } from "@/lib/sales/lead-lifecycle"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  try {
    const lead = await reopenLead(Number(id), { toStage: body.to_stage, note: body.note || null }, session.userId)
    return NextResponse.json({ success: true, lead })
  } catch (error) {
    if (error instanceof LeadNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[lead-reopen] failed", error)
    return NextResponse.json({ error: "Unable to reopen lead" }, { status: 500 })
  }
}
