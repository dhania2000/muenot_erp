import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createFieldSecurityPolicy, listFieldSecurityPolicies } from "@/lib/field-security"
import {
  CATEGORY_META,
  FIELD_EFFECTS,
  FIELD_SCOPE_TYPES,
  SCOPE_TYPE_META,
  SENSITIVE_CATEGORIES,
} from "@/lib/field-security-model"

// Field-Level Security admin API. Tenant-admin only, tenant-scoped,
// and audited (the store records every mutation to the immutable audit log).

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const policies = await listFieldSecurityPolicies(tenantId)
  // Ship the catalog alongside the data so the editor's selects stay in lockstep
  // with the pure model without hardcoding the taxonomy in the client.
  const catalog = {
    categories: SENSITIVE_CATEGORIES.map((value) => ({ value, ...CATEGORY_META[value] })),
    effects: FIELD_EFFECTS,
    scopeTypes: FIELD_SCOPE_TYPES.map((value) => ({ value, ...SCOPE_TYPE_META[value] })),
  }
  return NextResponse.json({ policies, catalog })
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
    const policy = await createFieldSecurityPolicy(
      tenantId,
      {
        module: body.module,
        entity: body.entity,
        field: body.field,
        category: body.category,
        scopeType: body.scopeType,
        scopeValue: body.scopeValue ?? "",
        effect: body.effect,
        enabled: body.enabled ?? true,
      },
      actor,
    )
    return NextResponse.json({ policy }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
