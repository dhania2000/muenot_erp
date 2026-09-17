import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureWebsiteAnalyticsSchema,
  listProperties,
  createProperty,
  IngestRejectedError,
} from "@/lib/marketing/website-analytics-db"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const url = new URL(request.url)
  const properties = await listProperties(url.searchParams.get("includeArchived") === "1")
  return NextResponse.json({ properties })
}

export async function POST(request: Request) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const created = await createProperty(body, session.userId)
    return NextResponse.json({ ok: true, ...created }, { status: 201 })
  } catch (error) {
    if (error instanceof IngestRejectedError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[wa] create property failed", error)
    return NextResponse.json({ error: "Unable to create property" }, { status: 500 })
  }
}
