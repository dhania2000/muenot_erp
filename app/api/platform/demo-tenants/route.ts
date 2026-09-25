import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { cloneDemoTenant, listDemoTenants, DemoTenantError } from "@/lib/demo-tenant-store"

/**
 * Spec26 — Demo tenant directory + clone.
 *
 * PLATFORM-axis surface: a customer tenant admin/owner is denied regardless of
 * tenant authority. Listing is staff-readable; provisioning a clone creates a
 * real tenant + admin credentials and is therefore super-admin only.
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const demoTenants = await listDemoTenants()
  return NextResponse.json({ demoTenants })
}

export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const idempotencyKey = req.headers.get("idempotency-key") ?? body?.idempotencyKey ?? null

  try {
    const result = await cloneDemoTenant(
      { userId: guard.ctx.userId, email: guard.session.email },
      body,
      idempotencyKey,
    )
    return NextResponse.json(result, { status: 201 })
  } catch (err: any) {
    const status = err instanceof DemoTenantError ? err.status : 400
    return NextResponse.json({ error: err?.message ?? "Failed to clone demo tenant" }, { status })
  }
}
