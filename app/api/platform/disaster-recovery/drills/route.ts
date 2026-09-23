import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { toDrDrillType, toDrServiceKey } from "@/lib/dr/model"
import { type DrActor, listDrills, runDrill } from "@/lib/dr/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json({ drills: await listDrills(100) })
  } catch (error) {
    console.error("[disaster-recovery] drill list failed", error)
    return NextResponse.json({ error: "Unable to load drills" }, { status: 500 })
  }
}

/** Run a restore / failover / tabletop drill for a service. */
export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  const key = toDrServiceKey(body?.serviceKey)
  const type = toDrDrillType(body?.drillType)
  if (!key) return NextResponse.json({ error: "A valid service is required" }, { status: 400 })
  if (!type) return NextResponse.json({ error: "A valid drill type is required" }, { status: 400 })
  const actor: DrActor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const drill = await runDrill(key, type, actor)
    return NextResponse.json({ ok: true, drill })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Drill failed" },
      { status: 400 },
    )
  }
}
