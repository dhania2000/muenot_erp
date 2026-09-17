import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureWebsiteAnalyticsSchema,
  listGoals,
  createGoal,
  IngestRejectedError,
} from "@/lib/marketing/website-analytics-db"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const url = new URL(request.url)
  const propertyId = Number(url.searchParams.get("propertyId")) || 0
  if (!propertyId) return NextResponse.json({ goals: [] })
  return NextResponse.json({ goals: await listGoals(propertyId) })
}

export async function POST(request: Request) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const propertyId = Number(body.property_id) || 0
    if (!propertyId) return NextResponse.json({ error: "property_id is required" }, { status: 400 })
    const goal = await createGoal(propertyId, body, session.userId)
    return NextResponse.json({ ok: true, goal }, { status: 201 })
  } catch (error) {
    if (error instanceof IngestRejectedError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[wa] create goal failed", error)
    return NextResponse.json({ error: "Unable to create goal" }, { status: 500 })
  }
}
