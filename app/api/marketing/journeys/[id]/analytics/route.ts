import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureJourneySchema, getJourneyAnalytics, getJourney } from "@/lib/marketing/journeys-db"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await context.params
  const journeyId = Number(id)
  const journey = await getJourney(journeyId)
  if (!journey) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const analytics = await getJourneyAnalytics(journeyId)
  return NextResponse.json({ analytics })
}
