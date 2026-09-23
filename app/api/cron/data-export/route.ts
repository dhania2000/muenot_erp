import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runDueExportSchedules } from "@/lib/data-export-store"

/**
 * SPEC 73 — Phase 3. Scheduled tenant exports.
 *
 * Runs unattended via the central scheduler (registered in lib/cron-jobs.ts)
 * authenticated with the shared CRON_SECRET Bearer token, and is also runnable
 * on demand by a signed-in user. Every due, active schedule produces one
 * scheduler-triggered export job (tenant-scoped, classification-redacted, and
 * audited) and advances its next-run pointer.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  if (!authorized(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const result = await runDueExportSchedules()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
