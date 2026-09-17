import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { ensureCampaignSchema, getCampaign, recordCampaignAudit } from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

/** Clone a campaign's content + audience into a fresh Draft (no recipients/history). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: idStr } = await params
  const src = await getCampaign(Number(idStr))
  if (!src || src.archived_at) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const raw = await nextRecordId("EMC", { allowCustom: true, digits: 6 })
  const seq = raw.split("-")[1] || "000001"
  const campaignCode = `EMC-${new Date().getFullYear()}-${seq}`

  const res = await query<any>(
    `INSERT INTO marketing_email_campaigns
       (campaign_code, name, description, type, status, subject, body_html, preheader, from_name, reply_to,
        template_id, audience_mode, audience_segments, audience_tags, audience_contacts, exclude_unsubscribed,
        track_opens, track_clicks, owner_id, sender_user_id, created_by)
     VALUES (?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      campaignCode,
      `${src.name} (copy)`.slice(0, 180),
      src.description,
      src.type,
      src.subject,
      src.body_html,
      src.preheader,
      src.from_name,
      src.reply_to,
      src.template_id,
      src.audience_mode,
      src.audience_segments || JSON.stringify([]),
      src.audience_tags || JSON.stringify([]),
      src.audience_contacts || JSON.stringify([]),
      src.exclude_unsubscribed,
      src.track_opens,
      src.track_clicks,
      session.userId,
      session.userId,
      session.userId,
    ],
  )
  const id = Number((res as any).insertId)
  await recordCampaignAudit({ campaignId: id, action: "duplicate", summary: `Duplicated from ${src.campaign_code}`, actorId: session.userId })
  const rows = await query<any[]>(`SELECT * FROM marketing_email_campaigns WHERE id = ?`, [id])
  return NextResponse.json({ campaign: rows[0] }, { status: 201 })
}
