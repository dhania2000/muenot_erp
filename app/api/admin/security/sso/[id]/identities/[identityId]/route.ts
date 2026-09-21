import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { deprovisionIdentity, getProviderById } from "@/lib/sso-store"

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; identityId: string }> }) {
  const session = await getSession()
  const tenant = getCurrentTenant()
  if (!session || session.role !== "admin" || !tenant) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id, identityId } = await params
  const provider = await getProviderById(Number(id))
  if (!provider || provider.tenant_id !== tenant.tenantId) return NextResponse.json({ error: "Not found" }, { status: 404 })
  try {
    await deprovisionIdentity({ providerId: provider.id, identityId: Number(identityId), tenantId: tenant.tenantId })
    return NextResponse.json({ ok: true })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to deprovision identity" }, { status: 400 }) }
}
