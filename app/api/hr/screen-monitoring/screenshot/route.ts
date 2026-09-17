import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  ensureMonitoringSchema,
  getMonitoringSettings,
  getSessionById,
  saveScreenshot,
  logMonitoringAudit,
} from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

// Hard cap so a malformed/huge upload can't exhaust memory (Phase 34).
const MAX_BYTES = 3 * 1024 * 1024

/**
 * POST — upload one 60-second screenshot for an active session. The client
 * sends multipart form-data with the compressed JPEG plus capture metadata.
 * The (session_pk, capture_sequence) unique key makes retries idempotent and
 * blocks duplicate captures (Phase 3 / Phase 33). Captures are rejected once a
 * session has stopped (Phase 5 — no post-clock-out screenshots).
 */
export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureMonitoringSchema()

    const settings = await getMonitoringSettings()
    if (!settings.enabled) return NextResponse.json({ error: "Monitoring disabled" }, { status: 400 })

    const form = await request.formData()
    const sessionPk = Number(form.get("sessionId"))
    const captureSequence = Number(form.get("captureSequence"))
    const sourceType = (form.get("sourceType") as string) || null
    const width = numOrNull(form.get("width"))
    const height = numOrNull(form.get("height"))
    const file = form.get("file")

    if (!sessionPk || !Number.isFinite(captureSequence) || captureSequence < 1) {
      return NextResponse.json({ error: "sessionId and captureSequence are required" }, { status: 400 })
    }
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Screenshot too large" }, { status: 413 })
    }

    const monitoring = await getSessionById(sessionPk)
    if (!monitoring) return NextResponse.json({ error: "Session not found" }, { status: 404 })
    // Only the owning employee may upload to their own live session.
    if (session.role !== "admin" && monitoring.user_id !== session.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const bytes = Buffer.from(arrayBuffer)

    const result = await saveScreenshot({
      session: monitoring,
      captureSequence,
      bytes,
      mime: file.type || "image/jpeg",
      width,
      height,
      sourceType,
    })

    if (!result.ok) {
      await logMonitoringAudit({
        action: "capture_failed",
        sessionPk: monitoring.id,
        sessionId: monitoring.session_id,
        employeeId: monitoring.employee_id,
        userId: session.userId,
        userName: session.name || session.email,
        detail: { captureSequence, error: result.error },
      })
      return NextResponse.json({ error: result.error }, { status: 409 })
    }

    if (!result.duplicate) {
      await logMonitoringAudit({
        action: "capture_created",
        sessionPk: monitoring.id,
        sessionId: monitoring.session_id,
        employeeId: monitoring.employee_id,
        userId: session.userId,
        userName: session.name || session.email,
        detail: { captureSequence, bytes: bytes.length },
      })
    }

    return NextResponse.json({ ok: true, duplicate: result.duplicate, screenshotId: result.screenshotId })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed" }, { status: 500 })
  }
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
