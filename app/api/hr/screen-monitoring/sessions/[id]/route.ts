import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getScope } from "@/lib/permission-store"
import { hasActionGrant } from "@/lib/permission-store"
import { query } from "@/lib/db"
import {
  ensureMonitoringSchema,
  getSessionById,
  logMonitoringAudit,
  MONITORING_MODULE_KEY,
} from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

/**
 * GET /sessions/:id — one session plus its ordered screenshot timeline for the
 * review console (Phase 13). Scope-checked: a non-"all" viewer may only open a
 * session they own. `DELETE` purges a single screenshot (retention management).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireFeature("hr.view_screen_monitoring")
    if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureMonitoringSchema()

    const { id } = await params
    const monitoring = await getSessionById(Number(id))
    if (!monitoring) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const scope = await getScope(auth.userId, auth.role, MONITORING_MODULE_KEY, "view")
    const isOwner = monitoring.user_id === auth.userId
    if (auth.role !== "admin" && scope !== "all" && !isOwner) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const shots = await query<any[]>(
      `SELECT id, screenshot_id, capture_sequence, captured_at, source_type,
              file_size, file_mime, width, height, upload_status,
              (file_data IS NOT NULL) AS has_data
         FROM screen_monitoring_screenshots
        WHERE session_pk = ?
        ORDER BY capture_sequence ASC`,
      [monitoring.id],
    )

    return NextResponse.json({
      session: monitoring,
      screenshots: shots.map((s) => ({ ...s, has_data: Boolean(Number(s.has_data)) })),
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load" }, { status: 500 })
  }
}

/**
 * DELETE /sessions/:id?screenshotId=<id> — purge a single screenshot's bytes,
 * or (without a screenshotId) purge every screenshot in the session. Requires
 * the retention-management grant and is fully audited (Phase 15 / Phase 16).
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireFeature("hr.view_screen_monitoring")
    if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const canManage =
      auth.role === "admin" || (await hasActionGrant(auth.userId, auth.role, MONITORING_MODULE_KEY, "manage_retention"))
    if (!canManage) return NextResponse.json({ error: "Retention management not permitted" }, { status: 403 })
    await ensureMonitoringSchema()

    const { id } = await params
    const monitoring = await getSessionById(Number(id))
    if (!monitoring) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const url = new URL(request.url)
    const screenshotId = url.searchParams.get("screenshotId")

    if (screenshotId) {
      await query(
        "UPDATE screen_monitoring_screenshots SET file_data = NULL, upload_status = 'Pending' WHERE session_pk = ? AND screenshot_id = ?",
        [monitoring.id, screenshotId],
      )
    } else {
      await query(
        "UPDATE screen_monitoring_screenshots SET file_data = NULL, upload_status = 'Pending' WHERE session_pk = ?",
        [monitoring.id],
      )
    }

    await logMonitoringAudit({
      action: "screenshot_deleted",
      sessionPk: monitoring.id,
      sessionId: monitoring.session_id,
      employeeId: monitoring.employee_id,
      userId: auth.userId,
      userName: auth.name || auth.email,
      detail: screenshotId ? { screenshotId } : { scope: "all-in-session" },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Delete failed" }, { status: 500 })
  }
}
