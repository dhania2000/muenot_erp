import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { ensureJourneySchema, recordJourneyEvent } from "@/lib/marketing/journeys-db"
import { exitEnrollment, processEnrollment } from "@/lib/marketing/journeys-engine"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ id: string; eid: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id, eid } = await context.params
  const journeyId = Number(id)
  const enrollmentId = Number(eid)

  const rows = await query<any[]>(
    `SELECT id, status FROM marketing_journey_enrollments WHERE id = ? AND journey_id = ? LIMIT 1`,
    [enrollmentId, journeyId],
  )
  if (!rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")

  if (action === "exit") {
    await exitEnrollment(enrollmentId, body.reason || "Manually removed", session.userId)
    return NextResponse.json({ ok: true })
  }
  if (action === "pause") {
    await query(
      `UPDATE marketing_journey_enrollments SET status = 'Paused', next_run_at = NULL, locked_at = NULL WHERE id = ?`,
      [enrollmentId],
    )
    await recordJourneyEvent({ journeyId, enrollmentId, action: "paused", detail: "Enrollment paused", actorId: session.userId })
    return NextResponse.json({ ok: true })
  }
  if (action === "resume") {
    await query(
      `UPDATE marketing_journey_enrollments SET status = 'Active', next_run_at = NOW(), locked_at = NULL WHERE id = ? AND status = 'Paused'`,
      [enrollmentId],
    )
    await recordJourneyEvent({ journeyId, enrollmentId, action: "resumed", detail: "Enrollment resumed", actorId: session.userId })
    await processEnrollment(enrollmentId).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
