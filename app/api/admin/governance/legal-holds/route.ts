import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createHold, listHolds } from "@/lib/legal-hold-store"
import { RETENTION_CATALOG } from "@/lib/retention-catalog"

// General ERP Legal Hold admin API. Tenant-admin only, tenant-scoped,
// and audited (the store records every mutation to the immutable audit log).
// Held records/files are never removed by the retention engine or the
// storage retention sweep.

export const runtime = "nodejs"

/** Catalog metadata so the UI can bind a hold to a known ERP record type. */
function catalogForClient() {
  return RETENTION_CATALOG.map((e) => ({
    key: e.key,
    module: e.module,
    recordType: e.recordType,
    description: e.description,
  }))
}

function actorFromGuard(guard: Extract<Awaited<ReturnType<typeof requireTenantAdmin>>, { ok: true }>) {
  return {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const holds = await listHolds(tenantId)
  return NextResponse.json({ holds, catalog: catalogForClient() })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const body = await request.json().catch(() => ({}))
  try {
    const hold = await createHold(tenantId, body, actorFromGuard(guard))
    return NextResponse.json({ hold }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
