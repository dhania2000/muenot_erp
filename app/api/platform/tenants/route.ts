import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { createTenant, listTenants } from "@/lib/tenant-service"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * Platform tenant directory. This is a PLATFORM-axis surface: only
 * Muenot platform staff/super-admins reach it. A customer tenant_admin/owner
 * is denied regardless of their tenant authority, because requirePlatform*()
 * consults only the platform axis.
 */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenants = await listTenants()
  return NextResponse.json({ tenants })
}

export async function POST(req: NextRequest) {
  // Creating tenants is a high-privilege platform action → super admin only.
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const tenant = await createTenant({
      name: String(body?.name ?? ""),
      slug: String(body?.slug ?? ""),
      plan: body?.plan ? String(body.plan) : undefined,
      deployment_model: body?.deployment_model,
      tenant_type: body?.tenant_type,
    })
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "create_tenant",
      targetTenantId: tenant.id,
      detail: { name: tenant.name, slug: tenant.slug, tenantType: tenant.tenant_type },
    })
    return NextResponse.json({ tenant }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to create tenant" }, { status: 400 })
  }
}
