import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureCampaignSchema } from "@/lib/marketing/campaigns-db"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: idStr } = await params
  const id = Number(idStr)

  const url = new URL(request.url)
  const p = url.searchParams
  const status = (p.get("status") || "").trim()
  const search = (p.get("search") || "").trim()
  const page = Math.max(1, Number(p.get("page") || 1))
  const pageSize = Math.min(100, Math.max(1, Number(p.get("pageSize") || 25)))
  const offset = (page - 1) * pageSize

  const where: string[] = ["campaign_id = ?"]
  const args: any[] = [id]
  if (status) {
    where.push("status = ?")
    args.push(status)
  }
  if (search) {
    where.push("(email LIKE ? OR name LIKE ?)")
    const q = `%${search}%`
    args.push(q, q)
  }
  const whereSql = `WHERE ${where.join(" AND ")}`

  const [rows, countRows] = await Promise.all([
    query<any[]>(
      `SELECT id, contact_id, contact_code, email, name, status, skip_reason, open_count, click_count,
              sent_at, first_opened_at, last_clicked_at, bounced_at, unsubscribed_at, last_error
         FROM marketing_campaign_recipients ${whereSql}
        ORDER BY FIELD(status,'Clicked','Opened','Delivered','Sent','Sending','Queued','Bounced','Failed','Unsubscribed','Skipped'), id ASC
        LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    ),
    query<any[]>(`SELECT COUNT(*) AS n FROM marketing_campaign_recipients ${whereSql}`, args),
  ])

  return NextResponse.json({ recipients: rows, total: Number(countRows[0]?.n || 0), page, pageSize })
}
