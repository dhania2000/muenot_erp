import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { deleteRole, getRole, getRoleMatrix, setRoleMatrix, updateRoleMeta } from "@/lib/role-store"
import { defaultMatrix, PERMISSION_MODULES, type PermissionMatrix } from "@/lib/permission-model"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const roleId = Number((await params).id)
  const role = await getRole(ctx.tenantId, roleId)
  if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 })

  // Fully-populated "none" matrix overlaid with saved values so the editor
  // always renders every module/action cell.
  const matrix = defaultMatrix("none")
  const saved = await getRoleMatrix(ctx.tenantId, roleId)
  for (const key of Object.keys(saved)) matrix[key] = { ...matrix[key], ...saved[key] }

  return NextResponse.json({ role, matrix })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const roleId = Number((await params).id)
  const role = await getRole(ctx.tenantId, roleId)
  if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 })

  const body = (await request.json().catch(() => null)) as
    | { name?: string; description?: string | null; matrix?: PermissionMatrix }
    | null
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

  if (body.name !== undefined || body.description !== undefined) {
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: "Role name cannot be empty" }, { status: 400 })
    }
    try {
      await updateRoleMeta(ctx.tenantId, roleId, { name: body.name, description: body.description })
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return NextResponse.json({ error: "A role with that name already exists" }, { status: 409 })
      }
      throw err
    }
  }

  if (body.matrix && typeof body.matrix === "object") {
    // Only persist known modules.
    const clean: PermissionMatrix = {}
    for (const mod of PERMISSION_MODULES) {
      const p = body.matrix[mod.key]
      if (p) clean[mod.key] = p
    }
    await setRoleMatrix(ctx.tenantId, roleId, clean)
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const roleId = Number((await params).id)
  await deleteRole(ctx.tenantId, roleId)
  return NextResponse.json({ ok: true })
}
