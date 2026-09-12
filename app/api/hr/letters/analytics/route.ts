import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureLetterTables } from "@/lib/hr-letters-db"

// Read-only aggregation for the Letters dashboard: lifecycle funnel, breakdowns
// by type / category / source / status, top templates, and a monthly trend.
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()

  const days = Math.min(365, Math.max(7, Number(request.nextUrl.searchParams.get("days")) || 180))
  const since = `${days} DAY`

  try {
    const [funnelRows, byStatus, byType, byCategory, bySource, topTemplates, trend] = await Promise.all([
      query<any[]>(
        `SELECT
           COUNT(*) AS total,
           SUM(status = 'Draft') AS drafts,
           SUM(status = 'Generated') AS generated,
           SUM(status = 'Issued') AS issued,
           SUM(status = 'Delivered') AS delivered,
           SUM(status = 'Cancelled') AS cancelled
         FROM hr_letters
         WHERE created_at >= (NOW() - INTERVAL ${since})`,
      ),
      query<any[]>(
        `SELECT status, COUNT(*) AS count FROM hr_letters
         WHERE created_at >= (NOW() - INTERVAL ${since}) GROUP BY status`,
      ),
      query<any[]>(
        `SELECT letter_type AS type, COUNT(*) AS count FROM hr_letters
         WHERE created_at >= (NOW() - INTERVAL ${since}) GROUP BY letter_type ORDER BY count DESC`,
      ),
      query<any[]>(
        `SELECT COALESCE(category,'General') AS category, COUNT(*) AS count FROM hr_letters
         WHERE created_at >= (NOW() - INTERVAL ${since}) GROUP BY category ORDER BY count DESC`,
      ),
      query<any[]>(
        `SELECT source, COUNT(*) AS count FROM hr_letters
         WHERE created_at >= (NOW() - INTERVAL ${since}) GROUP BY source ORDER BY count DESC`,
      ),
      query<any[]>(
        `SELECT l.template_id, t.name AS template_name, t.template_uid, COUNT(*) AS count
           FROM hr_letters l LEFT JOIN hr_letter_templates t ON t.id = l.template_id
          WHERE l.template_id IS NOT NULL AND l.created_at >= (NOW() - INTERVAL ${since})
          GROUP BY l.template_id, t.name, t.template_uid
          ORDER BY count DESC LIMIT 10`,
      ),
      query<any[]>(
        `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS total,
                SUM(status = 'Delivered') AS delivered
           FROM hr_letters
          WHERE created_at >= (NOW() - INTERVAL ${since})
          GROUP BY DATE_FORMAT(created_at, '%Y-%m') ORDER BY month ASC`,
      ),
    ])

    const f = funnelRows[0] || {}
    const total = Number(f.total || 0)
    const delivered = Number(f.delivered || 0)
    const issued = Number(f.issued || 0)

    return NextResponse.json({
      days,
      funnel: {
        total,
        drafts: Number(f.drafts || 0),
        generated: Number(f.generated || 0),
        issued,
        delivered,
        cancelled: Number(f.cancelled || 0),
        deliveryRate: total ? Math.round((delivered / total) * 1000) / 10 : 0,
      },
      byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
      byType: byType.map((r) => ({ type: r.type, count: Number(r.count) })),
      byCategory: byCategory.map((r) => ({ category: r.category, count: Number(r.count) })),
      bySource: bySource.map((r) => ({ source: r.source, count: Number(r.count) })),
      topTemplates: topTemplates.map((r) => ({
        templateId: r.template_id,
        name: r.template_name || "(deleted)",
        uid: r.template_uid,
        count: Number(r.count),
      })),
      trend: trend.map((r) => ({
        month: r.month,
        total: Number(r.total),
        delivered: Number(r.delivered || 0),
      })),
    })
  } catch (error) {
    console.log("[v0] hr letters analytics failed:", (error as Error).message)
    return NextResponse.json({ error: "Could not load analytics." }, { status: 500 })
  }
}
