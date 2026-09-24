import { NextResponse } from "next/server"
import { runExpirySweep } from "@/lib/expiry/service"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Document Expiry sweep (SPEC 88). Invoked by the cron dispatcher
 * (see lib/cron-jobs.ts → job key `document_expiry`). Classifies every
 * expiry-bearing record and fires deduped escalation notifications for anything
 * that has crossed a reminder milestone. Safe to run repeatedly — dedup keys
 * prevent re-notifying within a milestone window.
 */
export async function GET() {
  try {
    const result = await runExpirySweep()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.log("[v0] document-expiry cron failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 })
  }
}
