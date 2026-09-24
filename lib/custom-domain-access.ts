import "server-only"
/**
 * SPEC 157 — shared authorization for the custom-domain admin API.
 * ---------------------------------------------------------------------------
 * Every custom-domain endpoint requires BOTH:
 *   1. an authenticated tenant ADMIN (getSession sets the tenant context), and
 *   2. a plan that includes the `custom_domain` entitlement (enterprise).
 * Centralized here so all routes gate identically and can never drift.
 */
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { requireFeatureFlag } from "@/lib/platform/entitlement-guard"
import { CUSTOM_DOMAIN_FLAG } from "@/lib/custom-domain"

export type CustomDomainActor = { tenantId: number; userId: number }

export type AccessResult = { ok: true; actor: CustomDomainActor } | { ok: false; response: NextResponse }

export async function requireCustomDomainAdmin(): Promise<AccessResult> {
  const session = await getSession()
  if (!session || session.role !== "admin") {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  const tenant = getCurrentTenant()
  if (!tenant) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  const gate = await requireFeatureFlag(tenant.tenantId, CUSTOM_DOMAIN_FLAG)
  if (!gate.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Custom domains are not included in your plan.", upgrade: true },
        { status: gate.status },
      ),
    }
  }
  return { ok: true, actor: { tenantId: tenant.tenantId, userId: session.userId } }
}
