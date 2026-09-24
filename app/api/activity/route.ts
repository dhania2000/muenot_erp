import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import { ensureActivityTables, getTimeline, recordActivity } from "@/lib/activity/db"
import type { ActivityViewer } from "@/lib/activity/model"

function viewerFrom(session: any): ActivityViewer {
  return {
    userId: session.userId,
    role: session.role,
    features: Array.isArray(session.features) ? session.features : undefined,
    isPortal: session.isPortal === true || session.role === "portal",
  }
}

export async function GET(request: Request) {
  await ensureActivityTables()
  await ensureTenantIsolation()
  const session = await requireFeature("activity.view_timeline")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const kindsParam = url.searchParams.get("kinds")
  const kinds = kindsParam
    ? kindsParam.split(",").map((k) => k.trim()).filter(Boolean)
    : null

  const { events, nextCursor } = await getTimeline(
    {
      subjectType: url.searchParams.get("subjectType"),
      subjectId: url.searchParams.get("subjectId"),
      kinds,
      actorId: url.searchParams.get("actorId") ? Number(url.searchParams.get("actorId")) : null,
      sourceModule: url.searchParams.get("module"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : null,
    },
    viewerFrom(session),
  )

  return NextResponse.json({ events, nextCursor })
}

export async function POST(request: Request) {
  await ensureActivityTables()
  await ensureTenantIsolation()
  const session = await requireFeature("activity.record_activity")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  try {
    const recorded = await recordActivity({
      ...body,
      // The actor is always the authenticated user — never trusted from input.
      actor_id: session.userId,
    })
    return NextResponse.json({ ok: true, ...recorded }, { status: 201 })
  } catch (err: any) {
    if (err?.name === "ActivityValidationError") {
      return NextResponse.json({ error: "Validation failed", fields: err.fields }, { status: 400 })
    }
    throw err
  }
}

export const dynamic = "force-dynamic"
