import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [totals] = await query<any[]>(
    `SELECT
       COUNT(*) AS total_leads,
       SUM(status = 'Won') AS won_count,
       SUM(status = 'Lost') AS lost_count,
       SUM(status NOT IN ('Won','Lost')) AS open_count,
       SUM(follow_up_date IS NOT NULL AND follow_up_date < NOW() AND status NOT IN ('Won','Lost')) AS overdue_count,
       ROUND(AVG(lead_health_score), 0) AS avg_health_score
     FROM sales_leads`,
  )

  const byStatus = await query(
    `SELECT status, COUNT(*) AS count FROM sales_leads GROUP BY status ORDER BY count DESC`,
  )
  const bySource = await query(
    `SELECT COALESCE(lead_source, 'Unknown') AS source, COUNT(*) AS count
     FROM sales_leads GROUP BY lead_source ORDER BY count DESC`,
  )
  const byIndustry = await query(
    `SELECT COALESCE(industry, 'Unknown') AS industry, COUNT(*) AS count
     FROM sales_leads GROUP BY industry ORDER BY count DESC`,
  )

  const [revenue] = await query<any[]>(
    `SELECT
       COALESCE(SUM(value), 0) AS total_contract_value,
       COALESCE(AVG(value), 0) AS avg_deal_size,
       COUNT(*) AS contract_count
     FROM sales_contracts WHERE status = 'Active'`,
  )

  const forecast = await query(
    `SELECT quarter, year, expected_revenue, best_case, worst_case, pipeline_coverage
     FROM sales_revenue_forecast ORDER BY year ASC, quarter ASC`,
  )

  const upcomingMeetings = await query(
    `SELECT meeting_code, company_name, contact_person, meeting_date, meeting_time, meeting_type
     FROM sales_meetings WHERE meeting_date >= CURDATE() ORDER BY meeting_date ASC LIMIT 5`,
  )

  const winRate =
    totals.won_count + totals.lost_count > 0
      ? Math.round((totals.won_count / (totals.won_count + totals.lost_count)) * 100)
      : 0

  return NextResponse.json({
    totals: { ...totals, win_rate: winRate },
    byStatus,
    bySource,
    byIndustry,
    revenue,
    forecast,
    upcomingMeetings,
  })
}
