import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getRole, getRoleMembers } from "@/lib/role-store"

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

  const userIds = await getRoleMembers(ctx.tenantId, roleId)
  return NextResponse.json({ userIds })
}
