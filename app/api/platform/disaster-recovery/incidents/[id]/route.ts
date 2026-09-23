import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { toDrIncidentStatus } from "@/lib/dr/model"
import { type DrActor, addIncidentNote, getIncident, transitionIncident } from "@/lib/dr/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function parseId(value: string): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const incidentId = parseId(id)
  if (!incidentId) return NextResponse.json({ error: "Invalid incident id" }, { status: 400 })
  const found = await getIncident(incidentId)
  if (!found) return NextResponse.json({ error: "Incident not found" }, { status: 404 })
  return NextResponse.json(found)
}

/**
 * Advance the incident lifecycle or append a timeline note.
 * Body: { action: "transition", status } | { action: "note", message }
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const incidentId = parseId(id)
  if (!incidentId) return NextResponse.json({ error: "Invalid incident id" }, { status: 400 })
  const body = await req.json().catch(() => null)
  const actor: DrActor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }

  try {
    if (body?.action === "note") {
      const event = await addIncidentNote(incidentId, String(body?.message ?? ""), actor)
      return NextResponse.json({ ok: true, event })
    }
    if (body?.action === "transition") {
      const status = toDrIncidentStatus(body?.status)
      if (!status) return NextResponse.json({ error: "A valid target status is required" }, { status: 400 })
      const incident = await transitionIncident(incidentId, status, body?.message ?? null, actor)
      return NextResponse.json({ ok: true, incident })
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update incident" },
      { status: 400 },
    )
  }
}
