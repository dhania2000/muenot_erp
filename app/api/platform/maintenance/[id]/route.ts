import { NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { MaintenanceError, endWindow } from "@/lib/maintenance/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** End a window early (`complete`) or call it off (`cancel`). Idempotent. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid window id" }, { status: 400 })
  const body = await req.json().catch(() => null)
  const action = body?.action
  if (action !== "complete" && action !== "cancel") {
    return NextResponse.json({ error: "action must be complete or cancel" }, { status: 400 })
  }
  try {
    return NextResponse.json({ ok: true, window: await endWindow(id, action, { userId: guard.session.userId }) })
  } catch (error) {
    if (error instanceof MaintenanceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error("[maintenance] end failed", error)
    return NextResponse.json({ error: "Unable to update maintenance window" }, { status: 500 })
  }
}
