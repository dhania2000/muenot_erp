import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getIntegrationAudit } from "@/lib/secrets/tenant-integration-store"

/**
 * Audit history for the current tenant's integration secrets, optionally
 * filtered to one integration. Tenant-admin only (the trail names actors and
 * actions). Always tenant-scoped — one tenant never sees another's history.
 */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can view the audit history" }, { status: 403 })

  const url = new URL(req.url)
  const integrationKey = url.searchParams.get("integrationKey") ?? undefined
  const limitRaw = Number(url.searchParams.get("limit"))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined

  try {
    const events = await getIntegrationAudit({ integrationKey, limit })
    return NextResponse.json({ events })
  } catch (err) {
    console.error("[v0] tenant integration audit GET failed", err)
    return NextResponse.json({ error: "Unable to load audit history" }, { status: 500 })
  }
}
