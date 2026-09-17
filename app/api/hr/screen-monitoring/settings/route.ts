import { NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  ensureMonitoringSchema,
  getMonitoringSettings,
  saveMonitoringSettings,
  logMonitoringAudit,
  RETENTION_CHOICES,
  type MonitoringSettings,
} from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

/** GET — current monitoring settings for the admin config panel (Phase 7). */
export async function GET() {
  const session = await requireFeature("hr.view_screen_monitoring")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMonitoringSchema()
  const settings = await getMonitoringSettings()
  return NextResponse.json({ settings, retentionChoices: RETENTION_CHOICES })
}

/**
 * PUT — update capture interval, image quality, retention window and the
 * enabled flag. Requires the `manage_settings` extended grant (Phase 15).
 */
export async function PUT(request: Request) {
  const session = await requireModuleAction("hr.screen_monitoring", "manage_settings")
  if (!session) return NextResponse.json({ error: "Settings management not permitted" }, { status: 403 })
  await ensureMonitoringSchema()

  const body = (await request.json().catch(() => ({}))) as Partial<MonitoringSettings>
  const saved = await saveMonitoringSettings(
    {
      enabled: body.enabled,
      retention_days: body.retention_days,
      image_quality: body.image_quality,
      capture_interval_seconds: body.capture_interval_seconds,
      max_width: body.max_width,
      stale_after_minutes: body.stale_after_minutes,
    },
    session.userId,
  )
  await logMonitoringAudit({
    action: "settings_updated",
    userId: session.userId,
    userName: session.name || session.email,
    detail: saved as unknown as Record<string, unknown>,
  })
  return NextResponse.json({ settings: saved })
}
