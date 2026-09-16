import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runRecruitmentReminders } from "@/lib/recruit-email-automation"

export const runtime = "nodejs"

/**
 * Scheduled recruitment reminder + email dispatcher (Phases 41 & 46).
 *
 * Scans due Recruitment Tasks and Follow-ups, creates de-duplicated reminders
 * (interview / feedback / offer / offer-expiry / joining / follow-up / document
 * / BGV / reference) and emails the owning recruiter when SMTP is configured.
 * Runs unattended via Vercel Cron (see vercel.json) authenticated with the
 * shared `CRON_SECRET` Bearer token, and can also be triggered on demand by a
 * signed-in user for a manual sweep. Mirrors /api/cron/finance-emails.
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
  const result = await runRecruitmentReminders()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
