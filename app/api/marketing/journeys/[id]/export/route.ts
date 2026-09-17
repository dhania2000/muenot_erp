import { requireFeature } from "@/lib/api-auth"
import { NextResponse } from "next/server"
import { ensureJourneySchema, getJourney, listEnrollments } from "@/lib/marketing/journeys-db"

export const runtime = "nodejs"

function csvCell(value: any): string {
  const s = value == null ? "" : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await context.params
  const journeyId = Number(id)
  const journey = await getJourney(journeyId)
  if (!journey) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { items } = await listEnrollments(journeyId, { status: "all", page: 1, pageSize: 5000 })

  const header = ["Enrollment", "Contact", "Email", "Status", "Step", "Goal Reached", "Started", "Last Action", "Completed", "Exit Reason"]
  const rows = items.map((e) =>
    [
      e.enrollment_code,
      e.contact_name,
      e.contact_email,
      e.status,
      e.current_step_order,
      e.goal_reached ? "Yes" : "No",
      e.started_at,
      e.last_action_at,
      e.completed_at,
      e.exit_reason,
    ]
      .map(csvCell)
      .join(","),
  )
  const csv = [header.join(","), ...rows].join("\n")

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${journey.journey_code}-enrollments.csv"`,
    },
  })
}
