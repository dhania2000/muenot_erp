import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { processDueEnrollments } from "@/lib/marketing/journeys-engine"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Marketing Journeys engine sweep.
 *
 * Advances every enrollment whose `next_run_at` has arrived — sending the due
 * email / WhatsApp step, evaluating waits and branches, and completing or
 * exiting contacts. Runs unattended via Vercel Cron (see vercel.json) with the
 * shared `CRON_SECRET` Bearer token, and can also be triggered on demand by a
 * signed-in user. Mirrors /api/cron/sales-emails.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  if (!isAuthorizedCron(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const result = await processDueEnrollments(200)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
