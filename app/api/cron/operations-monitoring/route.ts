import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runOperationsMonitoring } from "@/lib/operations-automation"

export const runtime = "nodejs"

/**
 * Operations deadline + pending-queue monitoring sweep (Phases 57-60).
 *
 * Runs unattended via Vercel Cron (see vercel.json) authenticated with the
 * shared `CRON_SECRET` Bearer token — the SAME auth every other cron uses. Also
 * runnable on demand by a signed-in user so the dashboard can trigger a manual
 * sweep. Idempotency is enforced inside `runOperationsMonitoring` via the shared
 * dedup guard, so repeat runs never create duplicate notifications.
 */
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
  const result = await runOperationsMonitoring()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
