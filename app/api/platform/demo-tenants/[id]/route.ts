import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import {
  cleanupDemoTenant,
  extendDemoTenant,
  forceExpireDemoTenant,
  resetDemoTenant,
  DemoTenantError,
} from "@/lib/demo-tenant-store"

/**
 * Spec26 — single demo tenant lifecycle. Super-admin only; every action is
 * audited by the store.
 *   POST { action: "reset", rotateCredentials?: boolean }
 *   POST { action: "extend", days: 1..90 }
 *   POST { action: "expire" }
 *   DELETE → expire (if active) + purge this clone
 */
export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function errorResponse(err: any, fallback: string) {
  const status = err instanceof DemoTenantError ? err.status : 500
  return NextResponse.json({ error: err?.message ?? fallback }, { status })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const demoId = parseId((await params).id)
  if (!demoId) return NextResponse.json({ error: "Invalid demo tenant id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 })
  }
  const action = typeof body?.action === "string" ? body.action : ""
  const actor = { userId: guard.ctx.userId, email: guard.session.email }

  try {
    if (action === "reset") {
      const result = await resetDemoTenant(actor, demoId, { rotateCredentials: body.rotateCredentials === true })
      return NextResponse.json({ demoTenant: result.demo, adminTempPassword: result.adminTempPassword })
    }
    if (action === "extend") {
      return NextResponse.json({ demoTenant: await extendDemoTenant(actor, demoId, body.days) })
    }
    if (action === "expire") {
      return NextResponse.json({ demoTenant: await forceExpireDemoTenant(actor, demoId) })
    }
    return NextResponse.json({ error: 'action must be one of "reset", "extend", "expire"' }, { status: 400 })
  } catch (err: any) {
    return errorResponse(err, "Failed to update demo tenant")
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const demoId = parseId((await params).id)
  if (!demoId) return NextResponse.json({ error: "Invalid demo tenant id" }, { status: 400 })

  try {
    const demo = await cleanupDemoTenant({ userId: guard.ctx.userId, email: guard.session.email }, demoId)
    return NextResponse.json({ ok: true, demoTenant: demo })
  } catch (err: any) {
    return errorResponse(err, "Failed to clean up demo tenant")
  }
}
