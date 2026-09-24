import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listForms, saveForm } from "@/lib/custom-forms/store"
import { CONDITION_OPERATORS, FORM_FIELD_TYPES } from "@/lib/custom-forms/model"
import { TENANT_ROLES } from "@/lib/role-model"

export const dynamic = "force-dynamic"

const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  module_admin: "Module admin",
  tenant_admin: "Tenant admin",
  tenant_owner: "Tenant owner",
}

/** Admin + tenant gate shared by every custom-form definition route. */
async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** The static catalogue the builder needs to render its pickers. */
function catalogue() {
  return {
    fieldTypes: FORM_FIELD_TYPES,
    operators: CONDITION_OPERATORS,
    roles: TENANT_ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r] ?? r })),
  }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const forms = await listForms()
  return NextResponse.json({ forms, catalogue: catalogue() })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "A form definition is required." }, { status: 400 })
  }

  const result = await saveForm(body, ctx.session.userId)
  if (!result.ok) {
    return NextResponse.json({ error: result.errors.join(" "), errors: result.errors }, { status: 400 })
  }
  return NextResponse.json({ form: result.form }, { status: 201 })
}
