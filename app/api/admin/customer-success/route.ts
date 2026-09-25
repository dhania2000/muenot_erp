import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { getTenantHealth } from "@/lib/customer-success/store"
import { NO_STORE, csErrorResponse } from "@/lib/customer-success/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spec31 — the tenant admin's OWN health score, trend, churn-risk factors and
 * module usage. The tenant is derived from the guard context; any tenantId in
 * the query string is ignored, so another tenant can never be selected.
 */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status, headers: NO_STORE })
  const tenantId = effectiveTenantId(guard.ctx)
  if (!tenantId || tenantId < 1) return NextResponse.json({ error: "Tenant required" }, { status: 403, headers: NO_STORE })
  try {
    return NextResponse.json(await getTenantHealth(tenantId), { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to load customer health")
  }
}
