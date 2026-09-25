import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import {
  cloneDemoTenant,
  cleanupExpiredDemoTenants,
  ensureDemoTemplate,
  listDemoTenants,
  DemoTenantError,
} from "@/lib/demo-tenant-store"

/**
 * Spec26 — Demo tenant directory, template, clone and sweep.
 *
 * PLATFORM-axis surface: a customer tenant admin/owner is denied regardless of
 * tenant authority. Listing is staff-readable; everything that creates or
 * destroys tenants is super-admin only.
 *   GET                                 → list demo tenants
 *   POST { action: "clone", label, ttlDays }  (Idempotency-Key header honored)
 *   POST { action: "ensure_template" }
 *   POST { action: "cleanup" }          → expire overdue + purge expired clones
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json({ demoTenants: await listDemoTenants() })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to list demo tenants" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 })
  }
  const action = typeof body?.action === "string" ? body.action : "clone"
  const actor = { userId: guard.ctx.userId, email: guard.session.email }

  try {
    if (action === "clone") {
      const idempotencyKey = req.headers.get("idempotency-key") ?? body?.idempotencyKey ?? null
      const result = await cloneDemoTenant(actor, body, idempotencyKey)
      return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
    }
    if (action === "ensure_template") {
      return NextResponse.json({ template: await ensureDemoTemplate(actor) })
    }
    if (action === "cleanup") {
      return NextResponse.json({ summary: await cleanupExpiredDemoTenants(actor) })
    }
    return NextResponse.json({ error: 'action must be one of "clone", "ensure_template", "cleanup"' }, { status: 400 })
  } catch (err: any) {
    const status = err instanceof DemoTenantError ? err.status : 500
    return NextResponse.json({ error: err?.message ?? "Demo tenant request failed" }, { status })
  }
}
