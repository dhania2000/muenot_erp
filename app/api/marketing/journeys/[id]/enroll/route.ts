import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { ensureJourneySchema, getJourney } from "@/lib/marketing/journeys-db"
import { bulkEnroll, processDueEnrollments } from "@/lib/marketing/journeys-engine"

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await context.params
  const journeyId = Number(id)
  const journey = await getJourney(journeyId)
  if (!journey) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  let contactIds: number[] = Array.isArray(body.contactIds) ? body.contactIds.map(Number).filter(Boolean) : []

  // Optional: enroll everyone matching a saved segment.
  if (!contactIds.length && body.segmentId) {
    const rows = await query<any[]>(
      `SELECT contact_id FROM marketing_segment_members WHERE segment_id = ? LIMIT 5000`,
      [Number(body.segmentId)],
    )
    contactIds = rows.map((r) => Number(r.contact_id))
  }

  if (!contactIds.length) return NextResponse.json({ error: "No contacts to enroll" }, { status: 400 })

  const result = await bulkEnroll(journeyId, contactIds, {
    source: "manual",
    actorId: session.userId,
    force: journey.status !== "Active" ? false : undefined,
  })

  // Kick the engine so immediate steps fire without waiting for the cron.
  if (journey.status === "Active") {
    await processDueEnrollments(Math.min(200, contactIds.length + 10)).catch(() => {})
  }

  return NextResponse.json(result)
}
