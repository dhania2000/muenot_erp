import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getScope } from "@/lib/permission-store"
import { hasActionGrant } from "@/lib/permission-store"
import { query } from "@/lib/db"
import {
  ensureMonitoringSchema,
  logMonitoringAudit,
  MONITORING_MODULE_KEY,
} from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

/**
 * GET ?id=<screenshotId> — stream a single screenshot's bytes with authorization.
 *
 * Screenshots are NEVER public: the LONGBLOB is only served here after an
 * authenticated + authorized check (Phase 6 / Phase 25). Access rules:
 *   - the owning employee (their own capture), OR
 *   - a user whose `hr.screen_monitoring` VIEW scope is "all", OR admin.
 * `?download=1` forces an attachment and requires the download_screenshot grant.
 * Every view/download is audited (Phase 16 / Phase 28).
 */
export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureMonitoringSchema()

    const url = new URL(request.url)
    const screenshotId = url.searchParams.get("id")
    const isDownload = url.searchParams.get("download") === "1"
    if (!screenshotId) return NextResponse.json({ error: "id required" }, { status: 400 })

    const rows = await query<any[]>(
      `SELECT s.id, s.screenshot_id, s.file_mime, s.file_data, s.employee_id, s.session_pk, s.captured_at,
              ses.user_id
         FROM screen_monitoring_screenshots s
         JOIN screen_monitoring_sessions ses ON ses.id = s.session_pk
        WHERE s.screenshot_id = ? LIMIT 1`,
      [screenshotId],
    )
    const shot = rows[0]
    if (!shot) return NextResponse.json({ error: "Not found" }, { status: 404 })

    // Authorization: owner, or "all" view scope, or admin.
    const isOwner = shot.user_id != null && Number(shot.user_id) === session.userId
    let allowed = isOwner || session.role === "admin"
    if (!allowed) {
      const scope = await getScope(session.userId, session.role, MONITORING_MODULE_KEY, "view")
      allowed = scope === "all"
    }
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

    if (isDownload) {
      const canDownload =
        session.role === "admin" || (await hasActionGrant(session.userId, session.role, MONITORING_MODULE_KEY, "download_screenshot"))
      if (!canDownload) return NextResponse.json({ error: "Download not permitted" }, { status: 403 })
    }

    if (!shot.file_data) {
      // Bytes purged by retention — metadata retained but the image is gone.
      return NextResponse.json({ error: "Screenshot no longer available (retention)" }, { status: 410 })
    }

    await logMonitoringAudit({
      action: isDownload ? "screenshot_downloaded" : "screenshot_viewed",
      sessionPk: shot.session_pk,
      screenshotPk: shot.id,
      employeeId: shot.employee_id,
      userId: session.userId,
      userName: session.name || session.email,
      detail: { screenshotId },
    })

    const buffer: Buffer = Buffer.isBuffer(shot.file_data) ? shot.file_data : Buffer.from(shot.file_data)
    const headers = new Headers()
    headers.set("Content-Type", shot.file_mime || "image/jpeg")
    headers.set("Cache-Control", "private, no-store")
    headers.set("X-Content-Type-Options", "nosniff")
    if (isDownload) {
      headers.set("Content-Disposition", `attachment; filename="${screenshotId}.jpg"`)
    }
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load image" }, { status: 500 })
  }
}
