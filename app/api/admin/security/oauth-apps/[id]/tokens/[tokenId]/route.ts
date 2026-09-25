import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { revokeOAuthToken } from "@/lib/oauth/oauth-apps-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** Revokes a single access token. Scoped to the acting tenant + app. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; tokenId: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id, tokenId } = await params
  const appId = Number(id)
  const tid = Number(tokenId)
  if (!Number.isInteger(appId) || appId <= 0 || !Number.isInteger(tid) || tid <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }
  const changed = await revokeOAuthToken(ctx.tenantId, appId, tid, ctx.session.userId)
  if (!changed) return NextResponse.json({ error: "Token not found or already revoked" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
