import { NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { listCronRuns } from "@/lib/cron-jobs"
import { listSchedulerInventory } from "@/lib/scheduler"

export const dynamic = "force-dynamic"

/** Read-only platform inventory for the central scheduler and its run monitor. */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const [categories, runs] = await Promise.all([listSchedulerInventory(), listCronRuns(100)])
    return NextResponse.json({ categories, runs })
  } catch (error) {
    console.error("[scheduler] inventory read failed", error)
    return NextResponse.json({ error: "Unable to load scheduler inventory" }, { status: 500 })
  }
}
