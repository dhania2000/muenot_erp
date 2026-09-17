import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureCampaignSchema, getCampaign, getCampaignAnalytics } from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: idStr } = await params
  const id = Number(idStr)
  const campaign = await getCampaign(id)
  if (!campaign || campaign.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [analytics, timeline, topLinks] = await Promise.all([
    getCampaignAnalytics(id),
    query<any[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:00') AS hour, event_type, COUNT(*) AS n
         FROM marketing_campaign_events WHERE campaign_id = ? AND event_type IN ('open','click')
        GROUP BY hour, event_type ORDER BY hour ASC LIMIT 500`,
      [id],
    ).catch(() => []),
    query<any[]>(
      `SELECT url, COUNT(*) AS clicks, COUNT(DISTINCT recipient_id) AS unique_clicks
         FROM marketing_campaign_events WHERE campaign_id = ? AND event_type = 'click' AND url IS NOT NULL
        GROUP BY url ORDER BY clicks DESC LIMIT 20`,
      [id],
    ).catch(() => []),
  ])

  return NextResponse.json({ analytics, timeline, topLinks })
}
