import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getLinkOverview } from "@/lib/employee-user-link"

/**
 * SPEC 15 — Employee ⇄ User link console data.
 *
 * GET → the full mapping overview for the caller's effective tenant: every
 *       employee with its resolved login + relation, the lone users (service
 *       accounts / unlinked logins), linkable users, recent audit events, and
 *       the mapping stats. Tenant-admin gated.
 */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const overview = await getLinkOverview(tenantId)
  return NextResponse.json(overview)
}
