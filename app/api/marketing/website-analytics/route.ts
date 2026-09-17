import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureWebsiteAnalyticsSchema,
  listProperties,
  getPropertyById,
  listGoals,
  getAnalytics,
  getRealtime,
  getTrackingHealth,
  resolveRange,
} from "@/lib/marketing/website-analytics-db"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const properties = await listProperties()

  if (!properties.length) {
    return NextResponse.json({ properties: [], property: null, analytics: null })
  }

  const requestedId = Number(url.searchParams.get("propertyId")) || 0
  const property = (requestedId && (await getPropertyById(requestedId))) || properties[0]

  const range = resolveRange(
    url.searchParams.get("range") || "30d",
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  )
  const compare = url.searchParams.get("compare") === "1"

  const [analytics, realtime, health, goals] = await Promise.all([
    getAnalytics(property.id, range, { compare }),
    getRealtime(property.id),
    getTrackingHealth(property),
    listGoals(property.id),
  ])

  const origin = url.origin
  const manageSession = await requireFeature("marketing.website_analytics.manage")

  return NextResponse.json({
    properties: properties.map((p) => ({ id: p.id, name: p.name, tracking_id: p.tracking_id, status: p.status })),
    property: {
      id: property.id,
      property_code: property.property_code,
      tracking_id: property.tracking_id,
      name: property.name,
      domain: property.domain,
      status: property.status,
      timezone: property.timezone,
      currency: property.currency,
      session_timeout_minutes: property.session_timeout_minutes,
      retention_days: property.retention_days,
      exclude_bots: !!property.exclude_bots,
      last_event_at: property.last_event_at,
    },
    install: {
      scriptUrl: `${origin}/wa.js`,
      snippet: `<script async src="${origin}/wa.js" data-tracking-id="${property.tracking_id}"></script>`,
      collectUrl: `${origin}/api/marketing/website-analytics/collect`,
    },
    analytics,
    realtime,
    health,
    goals,
    can: { manage: !!manageSession },
  })
}
