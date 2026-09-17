import { NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import { getScope, scopeWhere } from "@/lib/permission-store"
import { query } from "@/lib/db"
import { ensureMonitoringSchema, logMonitoringAudit, MONITORING_MODULE_KEY } from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

/**
 * GET — export monitoring session metadata as CSV (Phase 15). Requires the
 * `export` grant; the export respects the caller's view scope so a scoped user
 * can only export sessions they may see. Screenshot bytes are never exported.
 */
export async function GET(request: Request) {
  try {
    const session = await requireModuleAction("hr.screen_monitoring", "export")
    if (!session) return NextResponse.json({ error: "Export not permitted" }, { status: 403 })
    await ensureMonitoringSchema()

    const url = new URL(request.url)
    const from = url.searchParams.get("from")
    const to = url.searchParams.get("to")
    const status = url.searchParams.get("status")

    const scope = await getScope(session.userId, session.role, MONITORING_MODULE_KEY, "view")
    const sc = scopeWhere(scope, MONITORING_MODULE_KEY, session.userId, "s")

    const where: string[] = [sc.sql]
    const params: unknown[] = [...sc.params]
    if (from) {
      where.push("s.work_date >= ?")
      params.push(from)
    }
    if (to) {
      where.push("s.work_date <= ?")
      params.push(to)
    }
    if (status) {
      where.push("s.status = ?")
      params.push(status)
    }

    const rows = await query<any[]>(
      `SELECT s.session_id, s.employee_name, s.attendance_ref, s.work_date, s.started_at, s.stopped_at,
              s.duration_seconds, s.status, s.permission_status, s.capture_count, s.browser, s.os
         FROM screen_monitoring_sessions s
        WHERE ${where.join(" AND ")}
        ORDER BY s.started_at DESC
        LIMIT 5000`,
      params,
    )

    const header = [
      "Session ID",
      "Employee",
      "Attendance Ref",
      "Work Date",
      "Started At",
      "Stopped At",
      "Duration (min)",
      "Status",
      "Permission",
      "Captures",
      "Browser",
      "OS",
    ]
    const lines = [header.join(",")]
    for (const r of rows) {
      lines.push(
        [
          r.session_id,
          r.employee_name,
          r.attendance_ref || "",
          r.work_date || "",
          r.started_at || "",
          r.stopped_at || "",
          r.duration_seconds != null ? (Number(r.duration_seconds) / 60).toFixed(1) : "",
          r.status,
          r.permission_status,
          r.capture_count,
          r.browser || "",
          r.os || "",
        ]
          .map(csvCell)
          .join(","),
      )
    }

    await logMonitoringAudit({
      action: "settings_updated",
      userId: session.userId,
      userName: session.name || session.email,
      detail: { export: true, rows: rows.length, from, to, status },
    })

    return new NextResponse(lines.join("\r\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="screen-monitoring-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Export failed" }, { status: 500 })
  }
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
