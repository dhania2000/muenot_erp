import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import {
  getDemoTenant,
  resetDemoTenant,
  cleanupExpiredDemoTenants,
  forceExpireDemoTenant,
  DemoTenantError,
} from "@/lib/demo-tenant-store"

/**
 * Spec26 — single demo tenant actions. Super-admin only: both reset (wipes and
 * re-materializes the clone's data) and cleanup (purges expired demo tenants)
 * are high-privilege, destructive platform actions and are audited by the store.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { id } = await params
  const demoId = Number(id)
  if (!Number.isInteger(demoId) || demoId <= 0) {
    return NextResponse.json({ error: "Invalid demo tenant id" }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const action = String(body?.action ?? "reset")
  const actor = { userId: guard.ctx.userId, email: guard.session.email }

  try {
    if (action === "reset") {
      const demo = await resetDemoTenant(actor, demoId)
      return NextResponse.json({ demoTenant: demo })
    }
    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
  } catch (err: any) {
    const status = err instanceof DemoTenantError ? err.status : 400
    return NextResponse.json({ error: err?.message ?? "Failed to update demo tenant" }, { status })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { id } = await params
  const demoId = Number(id)
  if (!Number.isInteger(demoId) || demoId <= 0) {
    return NextResponse.json({ error: "Invalid demo tenant id" }, { status: 400 })
  }

  const actor = { userId: guard.ctx.userId, email: guard.session.email }
  try {
    const demo = await getDemoTenant(demoId)
    if (!demo) return NextResponse.json({ error: "Demo tenant not found" }, { status: 404 })
    if (demo.kind !== "clone") {
      return NextResponse.json({ error: "Only cloned demo tenants can be cleaned up" }, { status: 400 })
    }
    // Force-expire this clone, then run the shared purge (which only touches expired clones).
    const { forceExpireDemoTenant } = await import("@/lib/demo-tenant-store")
    await forceExpireDemoTenant(demoId)
    const summary = await cleanupExpiredDemoTenants(actor)
    return NextResponse.json({ ok: true, summary })
  } catch (err: any) {
    const status = err instanceof DemoTenantError ? err.status : 400
    return NextResponse.json({ error: err?.message ?? "Failed to clean up demo tenant" }, { status })
  }
}
