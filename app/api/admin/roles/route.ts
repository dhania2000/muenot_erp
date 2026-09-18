import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { createRole, listRoles } from "@/lib/role-store"

/** Admin + tenant gate shared by every roles route. */
async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const roles = await listRoles(ctx.tenantId)
  return NextResponse.json({ roles })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as
    | { name?: string; description?: string | null }
    | null
  const name = body?.name?.trim()
  if (!name) return NextResponse.json({ error: "Role name is required" }, { status: 400 })
  if (name.length > 120) return NextResponse.json({ error: "Role name is too long" }, { status: 400 })

  try {
    const id = await createRole(ctx.tenantId, { name, description: body?.description ?? null }, ctx.session.userId)
    return NextResponse.json({ id }, { status: 201 })
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY") {
      return NextResponse.json({ error: "A role with that name already exists" }, { status: 409 })
    }
    throw err
  }
}
