import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getExpiryOverview, runExpirySweep } from "@/lib/expiry/service"

export const dynamic = "force-dynamic"

// GET — unified expiry dashboard payload (classified items + KPIs).
export async function GET() {
  const session = await requireFeature("operations.dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const overview = await getExpiryOverview()
  return NextResponse.json(overview)
}

// POST — run the notification/escalation sweep on demand (admin action).
export async function POST() {
  const session = await requireFeature("operations.dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const result = await runExpirySweep()
  return NextResponse.json({ ok: true, ...result })
}
