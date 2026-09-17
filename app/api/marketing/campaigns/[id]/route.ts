import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureCampaignSchema,
  getCampaign,
  getCampaignAnalytics,
  recordCampaignAudit,
  CAMPAIGN_TYPES,
} from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

const EDITABLE_ANYTIME = new Set(["name", "description", "owner_id"])

// Content / audience / config that may only change while a campaign is still
// editable (Draft, Scheduled, Paused).
const EDITABLE_WHEN_UNSENT = new Set([
  "subject",
  "body_html",
  "preheader",
  "from_name",
  "reply_to",
  "type",
  "template_id",
  "audience_mode",
  "audience_segments",
  "audience_tags",
  "audience_contacts",
  "exclude_unsubscribed",
  "track_opens",
  "track_clicks",
  "sender_user_id",
])

async function loadId(params: Promise<{ id: string }>) {
  const { id } = await params
  return Number(id)
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = await loadId(params)
  const campaign = await getCampaign(id)
  if (!campaign || campaign.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [analytics, audit] = await Promise.all([
    getCampaignAnalytics(id),
    query<any[]>(
      `SELECT a.action, a.summary, a.meta, a.created_at, u.name AS actor_name
         FROM marketing_campaign_audit a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.campaign_id = ? ORDER BY a.created_at DESC LIMIT 50`,
      [id],
    ).catch(() => []),
  ])

  return NextResponse.json({ campaign, analytics, audit })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = await loadId(params)
  const campaign = await getCampaign(id)
  if (!campaign || campaign.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))

  // Optimistic concurrency.
  if (body.row_version != null && Number(body.row_version) !== Number(campaign.row_version)) {
    return NextResponse.json({ error: "This campaign was modified elsewhere. Refresh and try again." }, { status: 409 })
  }

  const unsent = ["Draft", "Scheduled", "Paused"].includes(campaign.status)
  const sets: string[] = []
  const args: any[] = []

  for (const key of Object.keys(body)) {
    const isAnytime = EDITABLE_ANYTIME.has(key)
    const isUnsent = EDITABLE_WHEN_UNSENT.has(key)
    if (!isAnytime && !isUnsent) continue
    if (isUnsent && !unsent) {
      return NextResponse.json({ error: `Cannot edit "${key}" once a campaign has been sent or is sending.` }, { status: 409 })
    }
    let value = body[key]
    if (["audience_segments", "audience_tags", "audience_contacts"].includes(key)) {
      value = JSON.stringify(Array.isArray(value) ? value : [])
    } else if (["exclude_unsubscribed", "track_opens", "track_clicks"].includes(key)) {
      value = value ? 1 : 0
    } else if (key === "type" && !CAMPAIGN_TYPES.includes(value)) {
      continue
    } else if (value === "") {
      value = null
    }
    sets.push(`${key} = ?`)
    args.push(value)
  }

  if (sets.length === 0) return NextResponse.json({ campaign })

  sets.push("row_version = row_version + 1")
  args.push(id)
  await query(`UPDATE marketing_email_campaigns SET ${sets.join(", ")} WHERE id = ?`, args)
  await recordCampaignAudit({ campaignId: id, action: "update", summary: "Campaign updated", actorId: session.userId })

  const rows = await query<any[]>(`SELECT * FROM marketing_email_campaigns WHERE id = ?`, [id])
  return NextResponse.json({ campaign: rows[0] })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = await loadId(params)
  const campaign = await getCampaign(id)
  if (!campaign || campaign.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (campaign.status === "Sending") {
    return NextResponse.json({ error: "Pause or cancel the campaign before deleting it." }, { status: 409 })
  }

  await query(`UPDATE marketing_email_campaigns SET archived_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [id])
  await recordCampaignAudit({ campaignId: id, action: "delete", summary: "Campaign deleted", actorId: session.userId })
  return NextResponse.json({ ok: true })
}
