import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { resolveBaseUrl } from "@/lib/email"
import {
  ensureCampaignSchema,
  getCampaign,
  startSending,
  scheduleCampaign,
  unscheduleCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  processCampaignBatch,
  CampaignStateError,
} from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

/**
 * Single lifecycle endpoint. `action` picks the transition:
 *   send_now | schedule | pause | resume | cancel
 * On send_now we start sending and immediately process the first batch so the
 * user sees progress right away; the cron finishes the rest.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: idStr } = await params
  const id = Number(idStr)
  const campaign = await getCampaign(id)
  if (!campaign || campaign.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")

  try {
    if (action === "send_now") {
      if (!["Draft", "Scheduled", "Paused"].includes(campaign.status)) {
        return NextResponse.json({ error: "This campaign cannot be sent from its current state." }, { status: 409 })
      }
      const result = await startSending(campaign, session.userId)
      // Process the first batch synchronously for instant feedback.
      const baseUrl = resolveBaseUrl(request)
      const batch = await processCampaignBatch(id, baseUrl).catch((e) => {
        console.error("[campaigns] first batch failed", e)
        return null
      })
      return NextResponse.json({ ok: true, ...result, batch })
    }

    if (action === "schedule") {
      await scheduleCampaign(campaign, String(body.scheduledAt || ""), body.timezone ? String(body.timezone) : null, session.userId)
      return NextResponse.json({ ok: true })
    }

    if (action === "unschedule") {
      await unscheduleCampaign(campaign, session.userId)
      return NextResponse.json({ ok: true })
    }

    if (action === "pause") {
      await pauseCampaign(campaign, session.userId)
      return NextResponse.json({ ok: true })
    }

    if (action === "resume") {
      await resumeCampaign(campaign, session.userId)
      const baseUrl = resolveBaseUrl(request)
      const batch = await processCampaignBatch(id, baseUrl).catch(() => null)
      return NextResponse.json({ ok: true, batch })
    }

    if (action === "cancel") {
      await cancelCampaign(campaign, session.userId)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (err: any) {
    if (err instanceof CampaignStateError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error("[campaigns] transition failed", err)
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
  }
}
