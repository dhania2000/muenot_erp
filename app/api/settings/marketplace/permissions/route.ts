import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getConnectorPermissionReview } from "@/lib/marketplace/connector-store"

/**
 * Permission (scope) review for a connector. Any authenticated tenant member
 * may review which scopes a connector requests and which are currently granted
 * for the tenant's install. Read-only; no secret material is involved.
 */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const connectorKey = req.nextUrl.searchParams.get("connectorKey") ?? ""
  if (!connectorKey) return NextResponse.json({ error: "connectorKey is required" }, { status: 400 })

  try {
    const scopes = await getConnectorPermissionReview(connectorKey)
    return NextResponse.json({ scopes })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to load permission review" }, { status: 400 })
  }
}
