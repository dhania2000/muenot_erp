import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getScope, scopeWhere } from "@/lib/permission-store"
import { query } from "@/lib/db"
import { ensureMonitoringSchema, getMonitoringSettings, MONITORING_MODULE_KEY } from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

/** GET — headline KPIs for the review console dashboard cards (Phase 12). */
export async function GET() {
  try {
    const session = await requireFeature("hr.view_screen_monitoring")
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureMonitoringSchema()

    const scope = await getScope(session.userId, session.role, MONITORING_MODULE_KEY, "view")
    const sc = scopeWhere(scope, MONITORING_MODULE_KEY, session.userId, "s")

    const rows = await query<any[]>(
      `SELECT
         COUNT(*) AS total_sessions,
         SUM(CASE WHEN s.status = 'Active' THEN 1 ELSE 0 END) AS active_now,
         SUM(CASE WHEN s.status = 'Permission Denied' THEN 1 ELSE 0 END) AS denied,
         SUM(CASE WHEN s.status = 'Failed' THEN 1 ELSE 0 END) AS failed,
         SUM(s.capture_count) AS total_captures,
         SUM(CASE WHEN s.work_date = CURDATE() THEN 1 ELSE 0 END) AS sessions_today
       FROM screen_monitoring_sessions s
      WHERE ${sc.sql}`,
      sc.params,
    )
    const r = rows[0] || {}
    const settings = await getMonitoringSettings()

    return NextResponse.json({
      totals: {
        totalSessions: Number(r.total_sessions || 0),
        activeNow: Number(r.active_now || 0),
        denied: Number(r.denied || 0),
        failed: Number(r.failed || 0),
        totalCaptures: Number(r.total_captures || 0),
        sessionsToday: Number(r.sessions_today || 0),
      },
      settings: {
        enabled: settings.enabled,
        retentionDays: settings.retention_days,
        captureIntervalSeconds: settings.capture_interval_seconds,
        imageQuality: settings.image_quality,
        maxWidth: settings.max_width,
        staleAfterMinutes: settings.stale_after_minutes,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 })
  }
}
