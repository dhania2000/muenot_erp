import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureJourneySchema, getJourney, replaceJourneySteps, recordJourneyEvent } from "@/lib/marketing/journeys-db"

export const runtime = "nodejs"

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await context.params
  const journeyId = Number(id)
  const journey = await getJourney(journeyId)
  if (!journey) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  if (!Array.isArray(body.steps)) return NextResponse.json({ error: "steps array required" }, { status: 400 })

  await replaceJourneySteps(journeyId, body.steps)
  await recordJourneyEvent({ journeyId, action: "steps_updated", detail: `${body.steps.length} steps`, actorId: session.userId })

  return NextResponse.json({ ok: true })
}
