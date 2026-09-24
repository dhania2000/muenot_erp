import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listModules, saveModule } from "@/lib/custom-modules/store"
import { FIELD_TYPES, REPORT_OPS } from "@/lib/custom-modules/model"
import { TENANT_ROLES } from "@/lib/role-model"

export const dynamic = "force-dynamic"

const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  module_admin: "Module admin",
  tenant_admin: "Tenant admin",
  tenant_owner: "Tenant owner",
}

/** Admin + tenant gate shared by every module DEFINITION route. */
async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** Static catalogue the builder needs to render its pickers. */
function catalogue() {
  return {
    fieldTypes: FIELD_TYPES,
    reportOps: REPORT_OPS,
    roles: TENANT_ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r] ?? r })),
  }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const modules = await listModules()
  return NextResponse.json({ modules, catalogue: catalogue() })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "A module definition is required." }, { status: 400 })
  }

  const result = await saveModule(body, ctx.session.userId)
  if (!result.ok) {
    return NextResponse.json({ error: result.errors.join(" "), errors: result.errors }, { status: 400 })
  }
  return NextResponse.json({ module: result.module }, { status: 201 })
}
