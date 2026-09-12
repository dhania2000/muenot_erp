import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getLeadTimeline, getStageHistory, ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureLeadLifecycleSchema()
  const { id } = await params
  const leadId = Number(id)
  const [timeline, stageHistory] = await Promise.all([getLeadTimeline(leadId), getStageHistory(leadId)])
  return NextResponse.json({ timeline, stageHistory })
}
