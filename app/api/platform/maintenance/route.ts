import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { validateWindowInput } from "@/lib/maintenance/model"
import { MaintenanceError, createWindow, listAllWindows } from "@/lib/maintenance/store"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec28 (#125) — All maintenance windows (platform, tenant, module). Staff read. */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json({ windows: await listAllWindows(200) })
  } catch (error) {
    console.error("[maintenance] list failed", error)
    return NextResponse.json({ error: "Unable to load maintenance windows" }, { status: 500 })
  }
}

/** Schedule or start a window of any scope. Super admin only; Idempotency-Key honored. */
export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  const parsed = validateWindowInput(body as Record<string, unknown>)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  try {
    const { window, replayed } = await createWindow(
      parsed.value,
      { userId: guard.session.userId },
      normalizeIdempotencyKey(req.headers.get("idempotency-key")),
    )
    return NextResponse.json({ ok: true, window, replayed }, { status: replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof MaintenanceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error("[maintenance] create failed", error)
    return NextResponse.json({ error: "Unable to schedule maintenance" }, { status: 500 })
  }
}
