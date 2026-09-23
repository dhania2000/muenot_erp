import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createPolicy, listPolicies } from "@/lib/retention-engine"
import { RETENTION_CATALOG } from "@/lib/retention-catalog"

// SPEC 71 — General ERP Data Retention Engine admin API. Tenant-admin only,
// tenant-scoped, and audited (the engine records every mutation to the
// immutable audit log).

export const runtime = "nodejs"

/** Public metadata for the record-type catalog (no physical table names leaked). */
function catalogForClient() {
  return RETENTION_CATALOG.map((e) => ({
    key: e.key,
    module: e.module,
    recordType: e.recordType,
    description: e.description,
    allowDelete: e.allowDelete,
    suggestedDays: e.suggestedDays,
  }))
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const policies = await listPolicies(tenantId)
  return NextResponse.json({ policies, catalog: catalogForClient() })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const actor = {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
  const body = await request.json().catch(() => ({}))
  try {
    const policy = await createPolicy(tenantId, body, actor)
    return NextResponse.json({ policy }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
