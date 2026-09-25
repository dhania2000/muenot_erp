import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getConnectorAudit } from "@/lib/marketplace/connector-store"

/**
 * Connector lifecycle audit history for the current tenant. Tenant-admin only
 * because it names the acting users. Scoped to the workspace; credential values
 * are never recorded, so they can never appear here.
 */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can view connector audit history" }, { status: 403 })

  const connectorKey = req.nextUrl.searchParams.get("connectorKey") ?? undefined
  const limitRaw = Number(req.nextUrl.searchParams.get("limit"))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined

  try {
    const events = await getConnectorAudit({ connectorKey, limit })
    return NextResponse.json({ events })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to load audit history" }, { status: 500 })
  }
}
