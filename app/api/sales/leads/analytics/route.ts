import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"

export async function GET() {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureLeadLifecycleSchema()

  const [statusCounts, stageCounts, wonLost, overdue, pipelineValue] = await Promise.all([
    query<any[]>(
      `SELECT lead_status, COUNT(*) AS count FROM sales_leads WHERE archived_at IS NULL GROUP BY lead_status`,
    ),
    query<any[]>(
      `SELECT status, COUNT(*) AS count FROM sales_leads
       WHERE archived_at IS NULL AND lead_status = 'Open' OR lead_status = 'Follow Up'
       GROUP BY status`,
    ),
    query<any[]>(
      `SELECT
         SUM(lead_status = 'Won') AS won,
         SUM(lead_status = 'Lost') AS lost,
         SUM(CASE WHEN lead_status = 'Won' THEN COALESCE(won_value, estimated_value, 0) ELSE 0 END) AS won_value
       FROM sales_leads WHERE archived_at IS NULL`,
    ),
    query<{ overdue: number }[]>(
      `SELECT COUNT(*) AS overdue FROM sales_lead_followups WHERE status = 'Open' AND due_at < NOW()`,
    ),
    query<{ open_value: number }[]>(
      `SELECT COALESCE(SUM(estimated_value), 0) AS open_value FROM sales_leads
       WHERE archived_at IS NULL AND lead_status IN ('Open', 'Follow Up')`,
    ),
  ])

  const won = Number(wonLost[0]?.won || 0)
  const lost = Number(wonLost[0]?.lost || 0)
  const conversionRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0

  return NextResponse.json({
    statusCounts,
    stageCounts,
    won,
    lost,
    wonValue: Number(wonLost[0]?.won_value || 0),
    conversionRate,
    overdueFollowups: Number(overdue[0]?.overdue || 0),
    openPipelineValue: Number(pipelineValue[0]?.open_value || 0),
  })
}
