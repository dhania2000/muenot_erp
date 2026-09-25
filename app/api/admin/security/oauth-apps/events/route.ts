import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listOAuthEvents } from "@/lib/oauth/oauth-apps-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** Append-only OAuth audit trail for the acting tenant (optionally per-app). */
export async function GET(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const url = new URL(request.url)
  const appIdRaw = url.searchParams.get("appId")
  const appId = appIdRaw ? Number(appIdRaw) : undefined
  const events = await listOAuthEvents(ctx.tenantId, {
    appId: appId && Number.isInteger(appId) ? appId : undefined,
    limit: 200,
  })
  return NextResponse.json({ events })
}
