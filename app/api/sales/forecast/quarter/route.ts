import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { computeQuarterContributors } from "@/lib/sales/forecast-service"

/**
 * GET /api/sales/forecast/quarter?fy=<startYear>&q=<1-4>&owner=<userId>
 *
 * Forecast traceability: the exact opportunities that make up a quarter's
 * number, with their commercial lineage (lead → quotation → contract), stage,
 * probability, category, weighted contribution, expected close and risk.
 */
export async function GET(request: Request) {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const fyStartYear = Number(url.searchParams.get("fy"))
  const quarter = Number(url.searchParams.get("q"))
  const ownerParam = url.searchParams.get("owner")
  const ownerId = ownerParam && ownerParam !== "all" ? Number(ownerParam) : null

  if (!Number.isFinite(fyStartYear) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return NextResponse.json({ error: "fy and q (1-4) are required" }, { status: 400 })
  }

  const result = await computeQuarterContributors({
    fyStartYear,
    quarter,
    ownerId: Number.isFinite(ownerId as number) ? ownerId : null,
  })

  return NextResponse.json(result)
}
