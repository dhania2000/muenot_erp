import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { markLeadWon, LeadNotFoundError } from "@/lib/sales/lead-lifecycle"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const rawValue = body.value
  const value = rawValue === "" || rawValue == null ? null : Number(rawValue)
  if (value != null && (Number.isNaN(value) || value < 0)) {
    return NextResponse.json({ error: "Won value must be a non-negative number" }, { status: 400 })
  }

  try {
    const lead = await markLeadWon(
      Number(id),
      { value, currency: body.currency || null, notes: body.notes || null, eventKey: body.event_key || undefined },
      session.userId,
    )
    return NextResponse.json({ success: true, lead })
  } catch (error) {
    if (error instanceof LeadNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[lead-won] failed", error)
    return NextResponse.json({ error: "Unable to mark lead as won" }, { status: 500 })
  }
}
