import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { toDrServiceKey, toDrTier } from "@/lib/dr/model"
import {
  type DrActor,
  listDrills,
  listIncidents,
  listServiceReadiness,
  updateServicePlan,
} from "@/lib/dr/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/** DR posture overview: per-service readiness derived from real backup data. */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const [services, drills, incidents] = await Promise.all([
      listServiceReadiness(),
      listDrills(50),
      listIncidents(50),
    ])
    return NextResponse.json({ services, drills, incidents })
  } catch (error) {
    console.error("[disaster-recovery] read failed", error)
    return NextResponse.json({ error: "Unable to load disaster-recovery data" }, { status: 500 })
  }
}

/** Update a service's recovery objectives and recovery mechanism. */
export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  const key = toDrServiceKey(body?.serviceKey)
  if (!key) return NextResponse.json({ error: "A valid service is required" }, { status: 400 })
  const actor: DrActor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const service = await updateServicePlan(
      key,
      {
        rpoMinutes: body?.rpoMinutes,
        rtoMinutes: body?.rtoMinutes,
        recoveryMethod: body?.recoveryMethod,
        failoverStrategy: body?.failoverStrategy,
        tier: body?.tier != null ? toDrTier(body.tier) : undefined,
      },
      actor,
    )
    return NextResponse.json({ ok: true, service })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update service" },
      { status: 400 },
    )
  }
}
