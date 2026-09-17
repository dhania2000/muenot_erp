import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getScope, scopeWhere } from "@/lib/permission-store"
import { query } from "@/lib/db"
import { ensureMonitoringSchema, getMonitoringSettings, MONITORING_MODULE_KEY } from "@/lib/screen-monitoring"
import { getTimeZone, nowDateTimeInTz, hoursBetween } from "@/lib/hr-attendance"

export const dynamic = "force-dynamic"

/**
 * GET — the currently monitored employees for the "Live Employees" console.
 *
 * Returns only in-progress sessions (status = 'Active', not stopped) with the
 * latest uploaded screenshot reference so the UI can show a live thumbnail.
 * Freshness ("live" vs "stale") is derived from the configured
 * `stale_after_minutes` using the same app timezone the sessions are stored in,
 * so it stays consistent with the stale-detection cron (Phase 5 / Phase 12).
 * Scope-aware: an employee only sees their own session; "all"/admin see all.
 * This reuses the existing session store and screenshot endpoint — no new
 * capture pipeline or storage is introduced.
 */
export async function GET() {
  try {
    const session = await requireFeature("hr.view_screen_monitoring")
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureMonitoringSchema()

    const scope = await getScope(session.userId, session.role, MONITORING_MODULE_KEY, "view")
    const sc = scopeWhere(scope, MONITORING_MODULE_KEY, session.userId, "s")
    const settings = await getMonitoringSettings()
    const staleSeconds = Math.max(60, settings.stale_after_minutes * 60)

    const rows = await query<any[]>(
      `SELECT s.id, s.session_id, s.employee_id, s.employee_name, s.attendance_ref, s.work_date,
              s.started_at, s.last_capture_at, s.capture_count, s.permission_status,
              s.source_type, s.browser, s.os,
              (SELECT sh.screenshot_id
                 FROM screen_monitoring_screenshots sh
                WHERE sh.session_pk = s.id AND sh.upload_status = 'Uploaded'
                ORDER BY sh.capture_sequence DESC
                LIMIT 1) AS latest_screenshot_id
         FROM screen_monitoring_sessions s
        WHERE ${sc.sql}
          AND s.status = 'Active'
          AND s.stopped_at IS NULL
        ORDER BY (s.last_capture_at IS NULL), s.last_capture_at DESC, s.started_at DESC
        LIMIT 200`,
      sc.params,
    )

    const tz = await getTimeZone()
    const now = nowDateTimeInTz(tz)

    const employees = rows.map((r) => {
      const elapsedSeconds = Math.max(0, Math.round(hoursBetween(r.started_at, now) * 3600))
      const sinceCaptureSeconds =
        r.last_capture_at != null ? Math.max(0, Math.round(hoursBetween(r.last_capture_at, now) * 3600)) : null
      // Live when a capture arrived within the stale window. A brand-new session
      // with no capture yet gets the same grace window before it is flagged stale.
      const reference = sinceCaptureSeconds ?? elapsedSeconds
      const live = reference <= staleSeconds
      return {
        id: r.id,
        session_id: r.session_id,
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        attendance_ref: r.attendance_ref,
        work_date: r.work_date,
        started_at: r.started_at,
        last_capture_at: r.last_capture_at,
        capture_count: Number(r.capture_count || 0),
        permission_status: r.permission_status,
        source_type: r.source_type,
        browser: r.browser,
        os: r.os,
        latest_screenshot_id: r.latest_screenshot_id || null,
        elapsed_seconds: elapsedSeconds,
        since_capture_seconds: sinceCaptureSeconds,
        live,
      }
    })

    return NextResponse.json({
      employees,
      counts: {
        total: employees.length,
        live: employees.filter((e) => e.live).length,
        stale: employees.filter((e) => !e.live).length,
      },
      captureIntervalSeconds: settings.capture_interval_seconds,
      staleAfterMinutes: settings.stale_after_minutes,
      scope,
      generatedAt: now,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load" }, { status: 500 })
  }
}
