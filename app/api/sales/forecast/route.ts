import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const forecast = await query(
    `SELECT * FROM sales_revenue_forecast ORDER BY year DESC, quarter DESC`,
  )
  return NextResponse.json({ forecast })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  if (!body.quarter || !body.year) {
    return NextResponse.json({ error: "Quarter and year are required" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(forecast_code, 4) AS UNSIGNED)), 0) + 1 AS next FROM sales_revenue_forecast",
  )
  const forecastCode = `RF-${String(next).padStart(3, "0")}`

  const result = await query<any>(
    `INSERT INTO sales_revenue_forecast
     (forecast_code, forecast_date, quarter, year, expected_revenue, best_case, worst_case,
      pipeline_coverage, owner, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      forecastCode,
      new Date().toISOString().slice(0, 10),
      body.quarter,
      body.year,
      body.expected_revenue || 0,
      body.best_case || 0,
      body.worst_case || 0,
      body.pipeline_coverage || null,
      body.owner || null,
      session.userId,
    ],
  )

  return NextResponse.json({ id: result.insertId, forecast_code: forecastCode })
}
