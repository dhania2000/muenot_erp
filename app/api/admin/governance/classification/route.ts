import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import {
  createClassificationMapping,
  getClearanceMatrix,
  listClassificationMappings,
  setClearanceMatrix,
} from "@/lib/data-classification"
import { normalizeClearanceMatrix } from "@/lib/data-classification-model"

// Data Classification admin API. Tenant-admin only, tenant-scoped,
// and audited (the store records every mutation to the immutable audit log).

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const [mappings, clearance] = await Promise.all([listClassificationMappings(tenantId), getClearanceMatrix()])
  return NextResponse.json({ mappings, clearance })
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
    const mapping = await createClassificationMapping(
      tenantId,
      {
        module: body.module,
        entity: body.entity,
        field: body.field,
        level: body.level,
        enforceAccess: body.enforceAccess ?? false,
        enforceExport: body.enforceExport ?? true,
        enforceRetention: body.enforceRetention ?? false,
      },
      actor,
    )
    return NextResponse.json({ mapping }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

// Update the tenant-configurable clearance matrix.
export async function PUT(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const body = await request.json().catch(() => ({}))
  const matrix = normalizeClearanceMatrix(body.clearance)
  const clearance = await setClearanceMatrix(tenantId, matrix, {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  })
  return NextResponse.json({ clearance })
}
