import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getOAuthApp, listOAuthTokens } from "@/lib/oauth/oauth-apps-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** Lists the access tokens minted for one app (tenant-scoped). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const appId = Number(id)
  if (!Number.isInteger(appId) || appId <= 0) return NextResponse.json({ error: "Invalid app id" }, { status: 400 })

  // Confirm the app belongs to this tenant before exposing its tokens.
  const app = await getOAuthApp(ctx.tenantId, appId)
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 })

  const tokens = await listOAuthTokens(ctx.tenantId, appId)
  return NextResponse.json({ tokens })
}
