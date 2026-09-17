import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { resolveBaseUrl } from "@/lib/email"
import {
  ensureCampaignSchema,
  getCampaign,
  startSending,
  processCampaignBatch,
  SEND_BATCH_SIZE,
} from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Marketing campaign worker. Runs on a schedule (Vercel Cron, authenticated
 * with the shared CRON_SECRET Bearer token) and can also be triggered by a
 * signed-in user. Each pass:
 *   1. Promotes any Scheduled campaign whose time has arrived into Sending.
 *   2. Processes a batch of queued recipients for every Sending campaign.
 * It is safe to run frequently — recipients are claimed atomically, so
 * overlapping runs never double-send.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // no secret configured — allow (dev)
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function run(request: Request) {
  await ensureCampaignSchema()

  // 1) Promote due scheduled campaigns.
  const due = await query<any[]>(
    `SELECT id FROM marketing_email_campaigns
      WHERE status = 'Scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= UTC_TIMESTAMP() AND archived_at IS NULL
      LIMIT 25`,
  ).catch(() => [])
  const promoted: number[] = []
  for (const row of due) {
    const campaign = await getCampaign(Number(row.id))
    if (!campaign) continue
    try {
      await startSending(campaign, null)
      promoted.push(Number(row.id))
    } catch (err: any) {
      await query(`UPDATE marketing_email_campaigns SET status = 'Failed', last_error = ? WHERE id = ?`, [
        String(err?.message || "Failed to start").slice(0, 500),
        row.id,
      ]).catch(() => {})
    }
  }

  // 2) Process a batch for each active (Sending) campaign.
  const active = await query<any[]>(
    `SELECT id FROM marketing_email_campaigns WHERE status = 'Sending' AND archived_at IS NULL ORDER BY started_at ASC LIMIT 10`,
  ).catch(() => [])

  const baseUrl = resolveBaseUrl(request)
  const results: any[] = []
  for (const row of active) {
    try {
      const res = await processCampaignBatch(Number(row.id), baseUrl, SEND_BATCH_SIZE)
      results.push({ id: Number(row.id), ...res })
    } catch (err: any) {
      results.push({ id: Number(row.id), error: String(err?.message || err) })
    }
  }

  return { ok: true, promoted, processed: results }
}

export async function GET(request: Request) {
  // Cron (Bearer) or a signed-in user may trigger a pass.
  if (!isAuthorized(request)) {
    const session = await getSession().catch(() => null)
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const result = await run(request)
  return NextResponse.json(result)
}

export async function POST(request: Request) {
  return GET(request)
}
