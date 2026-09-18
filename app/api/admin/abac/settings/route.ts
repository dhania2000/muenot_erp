import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getAbacSettings, setAbacSettings } from "@/lib/abac-store"

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
  const settings = await getAbacSettings(ctx.tenantId)
  return NextResponse.json({ settings })
}

export async function PUT(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as
    | { algorithm?: string; defaultDecision?: string }
    | null
  await setAbacSettings(ctx.tenantId, {
    algorithm: body?.algorithm as any,
    defaultDecision: body?.defaultDecision as any,
  })
  const settings = await getAbacSettings(ctx.tenantId)
  return NextResponse.json({ settings })
}
