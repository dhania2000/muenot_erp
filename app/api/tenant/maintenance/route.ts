import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { validateWindowInput } from "@/lib/maintenance/model"
import { MaintenanceError, createWindow, listTenantWindows } from "@/lib/maintenance/store"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec28 (#125) — The caller's own tenant/module windows. Tenant admins only. */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  try {
    return NextResponse.json({ windows: await listTenantWindows(tenantId) })
  } catch (error) {
    console.error("[maintenance] tenant list failed", error)
    return NextResponse.json({ error: "Unable to load maintenance windows" }, { status: 500 })
  }
}

/**
 * Put the caller's workspace (or one module of it) into maintenance. The
 * tenant is pinned from the session — any tenantId in the body is ignored —
 * and platform-wide scope is refused outright.
 */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  if ((body as { scope?: unknown }).scope === "platform") {
    return NextResponse.json({ error: "Only platform administrators can schedule platform maintenance" }, { status: 403 })
  }
  const parsed = validateWindowInput({ ...(body as Record<string, unknown>), tenantId })
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
    console.error("[maintenance] tenant create failed", error)
    return NextResponse.json({ error: "Unable to schedule maintenance" }, { status: 500 })
  }
}
