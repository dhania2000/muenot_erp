import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { toDrServiceKey, toDrSeverity } from "@/lib/dr/model"
import { type DrActor, declareIncident, listIncidents } from "@/lib/dr/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json({ incidents: await listIncidents(100) })
  } catch (error) {
    console.error("[disaster-recovery] incident list failed", error)
    return NextResponse.json({ error: "Unable to load incidents" }, { status: 500 })
  }
}

/** Declare a new disaster-recovery incident. */
export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  const title = typeof body?.title === "string" ? body.title.trim() : ""
  if (!title) return NextResponse.json({ error: "An incident title is required" }, { status: 400 })
  const actor: DrActor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const incident = await declareIncident(
      {
        title,
        severity: toDrSeverity(body?.severity),
        serviceKey: body?.serviceKey ? toDrServiceKey(body.serviceKey) : null,
        summary: typeof body?.summary === "string" ? body.summary : null,
      },
      actor,
    )
    return NextResponse.json({ ok: true, incident })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to declare incident" },
      { status: 400 },
    )
  }
}
