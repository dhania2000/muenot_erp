import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getMarketplaceOverview } from "@/lib/marketplace/connector-store"

/**
 * Integration marketplace overview for the current tenant. Any authenticated
 * tenant member may VIEW the catalog and install state; only a tenant admin can
 * mutate it (see the install/reconnect/disconnect/health routes). The response
 * is the masked, secret-free projection — credential values never leave the
 * server.
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const connectors = await getMarketplaceOverview()
    return NextResponse.json({ connectors })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to load marketplace" }, { status: 500 })
  }
}
