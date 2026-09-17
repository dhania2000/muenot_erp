import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import {
  ensureCampaignSchema,
  recordCampaignAudit,
  CAMPAIGN_TYPES,
  type CampaignType,
} from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

const SORTABLE: Record<string, string> = {
  created_at: "created_at",
  name: "name",
  status: "status",
  scheduled_at: "scheduled_at",
  sent_count: "sent_count",
}

export async function GET(request: Request) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const p = url.searchParams
  const search = (p.get("search") || "").trim()
  const status = (p.get("status") || "").trim()
  const type = (p.get("type") || "").trim()
  const sort = SORTABLE[p.get("sort") || "created_at"] || "created_at"
  const dir = (p.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC"
  const page = Math.max(1, Number(p.get("page") || 1))
  const pageSize = Math.min(100, Math.max(1, Number(p.get("pageSize") || 20)))
  const offset = (page - 1) * pageSize

  const where: string[] = ["archived_at IS NULL"]
  const args: any[] = []
  if (search) {
    where.push("(name LIKE ? OR campaign_code LIKE ? OR subject LIKE ?)")
    const q = `%${search}%`
    args.push(q, q, q)
  }
  if (status) {
    where.push("status = ?")
    args.push(status)
  }
  if (type) {
    where.push("type = ?")
    args.push(type)
  }
  const whereSql = `WHERE ${where.join(" AND ")}`

  const [rows, countRows] = await Promise.all([
    query<any[]>(
      `SELECT id, campaign_code, name, description, type, status, subject, scheduled_at, timezone,
              audience_size, excluded_size, sent_count, failed_count, started_at, completed_at,
              owner_id, created_at, updated_at
         FROM marketing_email_campaigns ${whereSql}
        ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    ),
    query<any[]>(`SELECT COUNT(*) AS n FROM marketing_email_campaigns ${whereSql}`, args),
  ])

  // Status counts for the filter chips (unfiltered by status).
  const statusCounts = await query<any[]>(
    `SELECT status, COUNT(*) AS n FROM marketing_email_campaigns WHERE archived_at IS NULL GROUP BY status`,
  ).catch(() => [])

  return NextResponse.json({
    campaigns: rows,
    total: Number(countRows[0]?.n || 0),
    page,
    pageSize,
    statusCounts: Object.fromEntries(statusCounts.map((r) => [r.status, Number(r.n)])),
  })
}

export async function POST(request: Request) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const name = String(body.name || "").trim()
  if (!name) return NextResponse.json({ error: "A campaign name is required" }, { status: 400 })
  const type: CampaignType = CAMPAIGN_TYPES.includes(body.type) ? body.type : "Newsletter"

  const code = await nextRecordId("EMC", { allowCustom: true, digits: 6 })
  const year = new Date().getFullYear()
  const seq = code.split("-")[1] || "000001"
  const campaignCode = `EMC-${year}-${seq}`

  const res = await query<any>(
    `INSERT INTO marketing_email_campaigns
       (campaign_code, name, description, type, status, subject, body_html, preheader, from_name, reply_to,
        audience_mode, audience_segments, audience_tags, audience_contacts, exclude_unsubscribed,
        track_opens, track_clicks, owner_id, sender_user_id, created_by)
     VALUES (?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      campaignCode,
      name,
      body.description ? String(body.description).slice(0, 500) : null,
      type,
      String(body.subject || "").slice(0, 255),
      body.body_html ? String(body.body_html) : null,
      body.preheader ? String(body.preheader).slice(0, 255) : null,
      body.from_name ? String(body.from_name).slice(0, 160) : null,
      body.reply_to ? String(body.reply_to).slice(0, 190) : null,
      "segments",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      1,
      1,
      session.userId,
      session.userId,
      session.userId,
    ],
  )
  const id = Number((res as any).insertId)
  await recordCampaignAudit({ campaignId: id, action: "create", summary: `Campaign created: ${name}`, actorId: session.userId })

  const rows = await query<any[]>(`SELECT * FROM marketing_email_campaigns WHERE id = ?`, [id])
  return NextResponse.json({ campaign: rows[0] }, { status: 201 })
}
