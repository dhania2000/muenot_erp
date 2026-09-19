import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runCampaignScheduler } from "@/lib/whatsapp-campaigns"
import { runNoReplyAutomations } from "@/lib/whatsapp-automations"
import { syncTemplatesFromMeta } from "@/lib/whatsapp-templates"
import { forEachActiveTenant } from "@/lib/tenant-scope"

/**
 * Drives time-based work: sends due/scheduled campaign batches and fires
 * `no_reply` automations. Safe to call repeatedly (each unit is idempotent).
 *
 * Auth: either a valid admin session, or a Vercel Cron request carrying the
 * shared `CRON_SECRET` as a Bearer token so it can run unattended.
 */
async function run() {
  // `no_reply` automations read tenant-owned conversations/contacts, so they
  // must run inside a bound tenant context — fan out over every active tenant
  // rather than issuing a single cross-tenant query.
  const [campaigns, automationsFanout, templates] = await Promise.all([
    runCampaignScheduler(),
    forEachActiveTenant(() => runNoReplyAutomations()),
    // Reconcile template statuses/rejections with Meta on each tick. Best-effort:
    // a Graph outage must not stop campaign or automation processing.
    syncTemplatesFromMeta().catch((err) => ({ ok: false, error: (err as Error).message })),
  ])
  const automations = automationsFanout.reduce((sum, n) => sum + (typeof n === "number" ? n : 0), 0)
  return { ok: true, campaigns, automations, templates }
}

function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) {
    const session = await getSession()
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }
  return NextResponse.json(await run())
}

// Vercel Cron issues GET requests.
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return NextResponse.json(await run())
}
