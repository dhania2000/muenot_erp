import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { computeMonitoring, computeProjectProgress } from "@/lib/operations-automation"

export const runtime = "nodejs"

/**
 * Read-only monitoring feed for the Operations dashboard: derived project
 * progress (Phase 56) and the live deadline / pending-queue scan (Phase 57).
 * Uses the same derivation the cron uses so the UI and the notifications can
 * never disagree.
 */
export async function GET() {
  const session = await requireFeature("operations.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const [{ alerts, counts }, progress] = await Promise.all([computeMonitoring(), computeProjectProgress()])
    return NextResponse.json({
      counts,
      alerts: alerts.slice(0, 100),
      progress,
    })
  } catch (error) {
    console.log("[v0] operations monitoring failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to load monitoring" }, { status: 500 })
  }
}
