import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { reconcileUser } from "@/lib/calendar/sync-engine"

export const runtime = "nodejs"

/**
 * Manual "Sync now" for the signed-in user (spec Phases 47-49).
 *
 * Runs the same reconciliation pass the cron uses, but scoped to the current
 * user's own records: any source event whose Google sync previously failed (or
 * is still pending) is retried and its status updated. Safe to call repeatedly
 * — retries patch the existing Google event rather than creating duplicates.
 */
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const result = await reconcileUser(session.userId)
    const totals = result.results.reduce(
      (acc, r) => {
        acc.retried += r.retried
        acc.synced += r.synced
        acc.failed += r.failed
        return acc
      },
      { retried: 0, synced: 0, failed: 0 },
    )
    return NextResponse.json({ success: true, connected: result.connected, totals, byModule: result.results })
  } catch (error) {
    console.error("[v0] manual calendar sync failed:", (error as Error).message)
    return NextResponse.json({ success: false, error: "sync_failed" }, { status: 200 })
  }
}
