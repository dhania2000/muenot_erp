import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getTenantById } from "@/lib/tenant-service"
import { runForTenant } from "@/lib/tenant-scope"
import { createWhatsAppSignupSession, getSignupReadiness } from "@/lib/whatsapp-signup"
import { recordPlatformAudit } from "@/lib/platform-roles"

/** Read-only probe used by each platform tenant card before launch. */
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  return NextResponse.json(getSignupReadiness())
}

/** Start Meta Embedded Signup for one explicitly selected tenant. */
export async function POST(request: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const body = (await request.json().catch(() => ({}))) as { tenantId?: unknown }
  const tenantId = Number(body.tenantId)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "A valid tenantId is required." }, { status: 400 })
  }

  const tenant = await getTenantById(tenantId)
  if (!tenant) return NextResponse.json({ error: "Tenant not found." }, { status: 404 })
  if (tenant.status !== "active") {
    return NextResponse.json({ error: "WhatsApp can only be connected for an active tenant." }, { status: 409 })
  }

  try {
    const result = await runForTenant({ tenantId: tenant.id, slug: tenant.slug }, () =>
      createWhatsAppSignupSession(guard.ctx.userId),
    )
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "whatsapp_signup_start",
      targetTenantId: tenant.id,
      detail: { tenant: tenant.name, slug: tenant.slug },
    })
    return NextResponse.json({ ...result, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } })
  } catch (err) {
    console.error("[v0] platform whatsapp signup start error:", err)
    return NextResponse.json({ error: "Could not start WhatsApp signup for this tenant." }, { status: 500 })
  }
}
