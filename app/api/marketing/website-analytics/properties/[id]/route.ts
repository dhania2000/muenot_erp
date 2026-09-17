import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureWebsiteAnalyticsSchema,
  updateProperty,
  PropertyNotFoundError,
  IngestRejectedError,
} from "@/lib/marketing/website-analytics-db"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureWebsiteAnalyticsSchema()
  const session = await requireFeature("marketing.website_analytics.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    await updateProperty(Number(id), body, session.userId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof PropertyNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof IngestRejectedError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[wa] update property failed", error)
    return NextResponse.json({ error: "Unable to update property" }, { status: 500 })
  }
}
