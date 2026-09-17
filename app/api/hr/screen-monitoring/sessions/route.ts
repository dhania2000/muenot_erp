import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getScope, scopeWhere } from "@/lib/permission-store"
import { query } from "@/lib/db"
import { ensureMonitoringSchema, MONITORING_MODULE_KEY } from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

/**
 * GET — paginated monitoring session list for the admin/HR review console.
 * Scope-aware: an employee with "owned/added/both" only sees their own
 * sessions; "all" (or admin) sees everyone (Phase 4 / Phase 15). Supports
 * filtering by employee, date range and status (Phase 12).
 */
export async function GET(request: Request) {
  try {
    const session = await requireFeature("hr.view_screen_monitoring")
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureMonitoringSchema()

    const url = new URL(request.url)
    const employeeId = url.searchParams.get("employeeId")
    const status = url.searchParams.get("status")
    const from = url.searchParams.get("from")
    const to = url.searchParams.get("to")
    const search = url.searchParams.get("q")?.trim()
    const page = Math.max(1, Number(url.searchParams.get("page") || 1))
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") || 25)))
    const offset = (page - 1) * pageSize

    const scope = await getScope(session.userId, session.role, MONITORING_MODULE_KEY, "view")
    const scopeSql = scopeWhere(scope, MONITORING_MODULE_KEY, session.userId, "s")

    const where: string[] = [scopeSql.sql]
    const params: unknown[] = [...scopeSql.params]

    if (employeeId) {
      where.push("s.employee_id = ?")
      params.push(Number(employeeId))
    }
    if (status) {
      where.push("s.status = ?")
      params.push(status)
    }
    if (from) {
      where.push("s.work_date >= ?")
      params.push(from)
    }
    if (to) {
      where.push("s.work_date <= ?")
      params.push(to)
    }
    if (search) {
      where.push("(s.employee_name LIKE ? OR s.session_id LIKE ? OR s.attendance_ref LIKE ?)")
      params.push(`%${search}%`, `%${search}%`, `%${search}%`)
    }

    const whereSql = where.join(" AND ")

    const totalRows = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM screen_monitoring_sessions s WHERE ${whereSql}`,
      params,
    )
    const total = Number(totalRows[0]?.c || 0)

    const rows = await query<any[]>(
      `SELECT s.id, s.session_id, s.employee_id, s.employee_name, s.attendance_ref, s.work_date,
              s.started_at, s.stopped_at, s.duration_seconds, s.status, s.permission_status,
              s.capture_count, s.last_capture_at, s.source_type, s.browser, s.os
         FROM screen_monitoring_sessions s
        WHERE ${whereSql}
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    )

    return NextResponse.json({
      sessions: rows,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      scope,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load" }, { status: 500 })
  }
}
