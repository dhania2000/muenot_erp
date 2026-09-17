import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureWebsiteAnalyticsSchema,
  getPropertyById,
  listProperties,
  getAnalytics,
  resolveRange,
} from "@/lib/marketing/website-analytics-db"

export const dynamic = "force-dynamic"

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ""
  const headers = Object.keys(rows[0])
  const lines = [headers.join(",")]
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","))
  return lines.join("\n")
}

export async function GET(request: Request) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const properties = await listProperties()
  if (!properties.length) return NextResponse.json({ error: "No properties" }, { status: 404 })
  const requestedId = Number(url.searchParams.get("propertyId")) || 0
  const property = (requestedId && (await getPropertyById(requestedId))) || properties[0]

  const range = resolveRange(url.searchParams.get("range") || "30d", url.searchParams.get("from"), url.searchParams.get("to"))
  const dataset = url.searchParams.get("dataset") || "topPages"
  const analytics = await getAnalytics(property.id, range)

  const map: Record<string, any[]> = {
    topPages: analytics.topPages,
    channels: analytics.channels,
    referrers: analytics.referrers,
    utm: analytics.utmPerformance,
    devices: analytics.devices,
    browsers: analytics.browsers,
    countries: analytics.countries,
    campaigns: analytics.campaigns,
    landingPages: analytics.landingPages,
    goals: analytics.goals,
    events: analytics.events,
  }
  const rows = map[dataset] ?? analytics.topPages

  const csv = toCsv(rows)
  const filename = `${property.property_code}-${dataset}-${range.label}.csv`
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
