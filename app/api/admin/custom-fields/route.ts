import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listDefs, saveDef } from "@/lib/custom-fields/store"
import { ENTITY_TYPES, FIELD_TYPES } from "@/lib/custom-fields/model"
import { TENANT_ROLES } from "@/lib/role-model"

export const dynamic = "force-dynamic"

const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  module_admin: "Module admin",
  tenant_admin: "Tenant admin",
  tenant_owner: "Tenant owner",
}

/** Admin + tenant gate shared by every custom-field definition route. */
async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** The static catalogue the console needs to render its pickers. */
function catalogue() {
  return {
    fieldTypes: FIELD_TYPES,
    entities: ENTITY_TYPES,
    roles: TENANT_ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r] ?? r })),
  }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const fields = await listDefs()
  return NextResponse.json({ fields, catalogue: catalogue() })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "A field definition is required." }, { status: 400 })
  }

  const result = await saveDef(body, ctx.session.userId)
  if (!result.ok) {
    return NextResponse.json({ error: result.errors.join(" "), errors: result.errors }, { status: 400 })
  }
  return NextResponse.json({ field: result.def }, { status: 201 })
}
