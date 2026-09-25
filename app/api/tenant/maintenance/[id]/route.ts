import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { MaintenanceError, endWindow } from "@/lib/maintenance/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** End/cancel one of the caller's OWN tenant windows. Others' windows → 404. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid window id" }, { status: 400 })
  const body = await req.json().catch(() => null)
  const action = body?.action
  if (action !== "complete" && action !== "cancel") {
    return NextResponse.json({ error: "action must be complete or cancel" }, { status: 400 })
  }
  try {
    return NextResponse.json({ ok: true, window: await endWindow(id, action, { userId: guard.session.userId }, tenantId) })
  } catch (error) {
    if (error instanceof MaintenanceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error("[maintenance] tenant end failed", error)
    return NextResponse.json({ error: "Unable to update maintenance window" }, { status: 500 })
  }
}
