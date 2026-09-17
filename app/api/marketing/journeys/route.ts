import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureJourneySchema,
  listJourneys,
  createJourney,
  replaceJourneySteps,
  getJourneysSummary,
  recordJourneyEvent,
  type TriggerType,
} from "@/lib/marketing/journeys-db"

export const runtime = "nodejs"

export async function GET(request: Request) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const p = new URL(request.url).searchParams
  const [{ items, total }, summary] = await Promise.all([
    listJourneys({
      search: (p.get("search") || "").trim(),
      status: p.get("status") || "all",
      trigger: p.get("trigger") || "all",
      sort: p.get("sort") || "recent",
      page: Number(p.get("page") || 1),
      pageSize: Number(p.get("pageSize") || 20),
    }),
    getJourneysSummary(),
  ])

  return NextResponse.json({ items, total, summary })
}

export async function POST(request: Request) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const name = String(body.name || "").trim()
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 })

  const id = await createJourney({
    name,
    description: body.description ?? null,
    trigger_type: (body.trigger_type as TriggerType) || "manual",
    trigger_config: body.trigger_config ?? null,
    audience_config: body.audience_config ?? null,
    goal_type: body.goal_type ?? null,
    goal_config: body.goal_config ?? null,
    owner_id: body.owner_id ?? session.userId,
    allow_reentry: !!body.allow_reentry,
    allow_multiple_active: !!body.allow_multiple_active,
    quiet_hours_start: body.quiet_hours_start ?? null,
    quiet_hours_end: body.quiet_hours_end ?? null,
    created_by: session.userId,
  })

  if (Array.isArray(body.steps)) {
    await replaceJourneySteps(id, body.steps)
  }

  await recordJourneyEvent({
    journeyId: id,
    action: "created",
    detail: `Journey "${name}" created`,
    actorId: session.userId,
  })

  return NextResponse.json({ id })
}
