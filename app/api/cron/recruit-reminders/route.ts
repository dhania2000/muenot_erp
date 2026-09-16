import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runRecruitmentReminders } from "@/lib/recruit-email-automation"
import { runStaleDetection } from "@/lib/recruit-stale-detection"
import { runOfferAndJoiningAutomation } from "@/lib/recruit-offer-joining-automation"

export const runtime = "nodejs"

/**
 * Scheduled recruitment reminder + email dispatcher (Phases 41, 46, 66-68, 69 & 70).
 *
 * Scans due Recruitment Tasks and Follow-ups, creates de-duplicated reminders
 * (interview / feedback / offer / offer-expiry / joining / follow-up / document
 * / BGV / reference) and emails the owning recruiter when SMTP is configured.
 * It then runs the stale sweep (Phases 66-68) which notifies recruiters about
 * applications stuck in a stage, requisitions past their target date and open
 * jobs with no recent activity, and the offer/joining sweep (Phases 69 & 70)
 * which sends tiered before-expiry offer reminders, marks lapsed offers expired
 * when the business rule allows (never accepted ones), and sends tiered
 * joining reminders — all de-duplicated via `recruitment_reminder_log` so a
 * record pings at most once per tier no matter how often the cron runs.
 *
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
  const stale = await runStaleDetection().catch((err) => {
    console.error("[recruit-reminders] stale sweep failed", err)
    return null
  })
  const offers = await runOfferAndJoiningAutomation().catch((err) => {
    console.error("[recruit-reminders] offer/joining sweep failed", err)
    return null
  })
  return NextResponse.json({ success: true, ...result, stale, offers })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
