import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { createPolicy, listPolicies } from "@/lib/abac-store"

/** Admin + tenant gate shared by every ABAC route. */
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
  const policies = await listPolicies(ctx.tenantId)
  return NextResponse.json({ policies })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const id = await createPolicy(ctx.tenantId, body, ctx.session.userId)
  if (id == null) {
    return NextResponse.json({ error: "Invalid policy — check name, effect and conditions." }, { status: 400 })
  }
  return NextResponse.json({ id }, { status: 201 })
}
