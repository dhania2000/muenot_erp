import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureJourneySchema,
  getJourney,
  getJourneySteps,
  updateJourney,
  setJourneyStatus,
  replaceJourneySteps,
  duplicateJourney,
  recordJourneyEvent,
  parseJson,
  type JourneyStatus,
} from "@/lib/marketing/journeys-db"

export const runtime = "nodejs"

async function loadId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return Number(id)
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = await loadId(context)
  const journey = await getJourney(id)
  if (!journey) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const steps = await getJourneySteps(id)

  return NextResponse.json({
    journey: {
      ...journey,
      trigger_config: parseJson(journey.trigger_config, null),
      audience_config: parseJson(journey.audience_config, null),
      goal_config: parseJson(journey.goal_config, null),
    },
    steps: steps.map((s) => ({ ...s, config: parseJson(s.config, {}) })),
  })
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = await loadId(context)
  const journey = await getJourney(id)
  if (!journey) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))

  // Status transition.
  if (body.action === "status" && body.status) {
    const target = body.status as JourneyStatus
    if (target === "Active") {
      const steps = await getJourneySteps(id)
      if (!steps.some((s) => s.enabled)) {
        return NextResponse.json({ error: "Add at least one step before activating." }, { status: 400 })
      }
    }
    await setJourneyStatus(id, target)
    await recordJourneyEvent({
      journeyId: id,
      action: "status_changed",
      detail: `Status → ${target}`,
      actorId: session.userId,
    })
    return NextResponse.json({ ok: true })
  }

  // Field updates.
  await updateJourney(id, {
    name: body.name,
    description: body.description,
    trigger_type: body.trigger_type,
    trigger_config: body.trigger_config,
    audience_config: body.audience_config,
    goal_type: body.goal_type,
    goal_config: body.goal_config,
    owner_id: body.owner_id,
    allow_reentry: body.allow_reentry,
    allow_multiple_active: body.allow_multiple_active,
    quiet_hours_start: body.quiet_hours_start,
    quiet_hours_end: body.quiet_hours_end,
  })

  if (Array.isArray(body.steps)) {
    await replaceJourneySteps(id, body.steps)
  }

  await recordJourneyEvent({
    journeyId: id,
    action: "updated",
    detail: "Journey updated",
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true })
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = await loadId(context)
  const body = await request.json().catch(() => ({}))
  if (body.action === "duplicate") {
    const newId = await duplicateJourney(id, session.userId)
    if (!newId) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ id: newId })
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = await loadId(context)
  await setJourneyStatus(id, "Archived")
  await recordJourneyEvent({ journeyId: id, action: "archived", detail: "Journey archived", actorId: session.userId })
  return NextResponse.json({ ok: true })
}
