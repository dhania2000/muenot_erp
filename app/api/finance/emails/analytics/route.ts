import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureFinanceEmailHubSchema } from "@/lib/finance-email"

/**
 * Finance email analytics — the finance-side mirror of the HR analytics route.
 *
 * Aggregates the single `finance_emails` table into the numbers the Analytics
 * tab renders: delivery funnel, open rate, manual-vs-automated split,
 * per-category and per-status breakdowns, top automated flows, and a daily
 * volume trend. Read-only; gated on the same feature as the rest of the hub.
 */
export async function GET(request: NextRequest) {
  const session = await requireFeature("finance.emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureFinanceEmailHubSchema()

  const days = Math.min(365, Math.max(7, Number(request.nextUrl.searchParams.get("days")) || 30))
  const since = `${days} DAY`

  try {
    const [funnelRows, byStatus, byCategory, byType, byEvent, trend] = await Promise.all([
      query<any[]>(
        `SELECT
           COUNT(*) AS total,
           SUM(status = 'Sent') AS sent,
           SUM(status = 'Failed') AS failed,
           SUM(status IN ('Scheduled','Queued','Sending')) AS pending,
           SUM(status = 'Draft') AS drafts,
           SUM(status = 'Cancelled') AS cancelled,
           SUM(COALESCE(open_count,0) > 0) AS opened,
           SUM(COALESCE(open_count,0)) AS total_opens
         FROM finance_emails
         WHERE created_at >= (NOW() - INTERVAL ${since})`,
      ),
      query<any[]>(
        `SELECT status, COUNT(*) AS count
         FROM finance_emails
         WHERE created_at >= (NOW() - INTERVAL ${since})
         GROUP BY status`,
      ),
      query<any[]>(
        `SELECT category, COUNT(*) AS count,
                SUM(status = 'Sent') AS sent,
                SUM(COALESCE(open_count,0) > 0) AS opened
         FROM finance_emails
         WHERE created_at >= (NOW() - INTERVAL ${since})
         GROUP BY category
         ORDER BY count DESC`,
      ),
      query<any[]>(
        `SELECT email_type AS type, COUNT(*) AS count
         FROM finance_emails
         WHERE created_at >= (NOW() - INTERVAL ${since})
         GROUP BY email_type`,
      ),
      query<any[]>(
        `SELECT source_module AS module, COUNT(*) AS count,
                SUM(status = 'Sent') AS sent,
                SUM(status = 'Failed') AS failed
         FROM finance_emails
         WHERE email_type = 'Automated'
           AND created_at >= (NOW() - INTERVAL ${since})
         GROUP BY source_module
         ORDER BY count DESC
         LIMIT 10`,
      ),
      query<any[]>(
        `SELECT DATE(created_at) AS day,
                COUNT(*) AS total,
                SUM(status = 'Sent') AS sent,
                SUM(status = 'Failed') AS failed
         FROM finance_emails
         WHERE created_at >= (NOW() - INTERVAL ${since})
         GROUP BY DATE(created_at)
         ORDER BY day ASC`,
      ),
    ])

    const f = funnelRows[0] || {}
    const total = Number(f.total || 0)
    const sent = Number(f.sent || 0)
    const opened = Number(f.opened || 0)

    const funnel = {
      total,
      sent,
      failed: Number(f.failed || 0),
      pending: Number(f.pending || 0),
      drafts: Number(f.drafts || 0),
      cancelled: Number(f.cancelled || 0),
      opened,
      totalOpens: Number(f.total_opens || 0),
      deliveryRate: total ? Math.round((sent / total) * 1000) / 10 : 0,
      openRate: sent ? Math.round((opened / sent) * 1000) / 10 : 0,
    }

    return NextResponse.json({
      days,
      funnel,
      byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
      byCategory: byCategory.map((r) => ({
        category: r.category,
        count: Number(r.count),
        sent: Number(r.sent || 0),
        opened: Number(r.opened || 0),
      })),
      byType: byType.map((r) => ({ type: r.type, count: Number(r.count) })),
      byEvent: byEvent.map((r) => ({
        module: r.module,
        count: Number(r.count),
        sent: Number(r.sent || 0),
        failed: Number(r.failed || 0),
      })),
      trend: trend.map((r) => ({
        day: String(r.day).slice(0, 10),
        total: Number(r.total),
        sent: Number(r.sent || 0),
        failed: Number(r.failed || 0),
      })),
    })
  } catch (error) {
    console.log("[v0] finance email analytics failed:", (error as Error).message)
    return NextResponse.json({ error: "Could not load analytics." }, { status: 500 })
  }
}
