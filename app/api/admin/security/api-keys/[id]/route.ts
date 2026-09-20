import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { deleteApiKey, revokeApiKey } from "@/lib/api-keys-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { action?: string } | null
  if (body?.action !== "revoke") return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  await revokeApiKey(ctx.tenantId, Number(id))
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  await deleteApiKey(ctx.tenantId, Number(id))
  return NextResponse.json({ ok: true })
}
