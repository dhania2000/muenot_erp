import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { markLeadLost, LeadNotFoundError } from "@/lib/sales/lead-lifecycle"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.reason) {
    return NextResponse.json({ error: "A lost reason is required" }, { status: 400 })
  }

  try {
    const lead = await markLeadLost(
      Number(id),
      { reason: String(body.reason), notes: body.notes || null, eventKey: body.event_key || undefined },
      session.userId,
    )
    return NextResponse.json({ success: true, lead })
  } catch (error) {
    if (error instanceof LeadNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[lead-lost] failed", error)
    return NextResponse.json({ error: "Unable to mark lead as lost" }, { status: 500 })
  }
}
