import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getTenantFeatureMap } from "@/lib/platform/feature-guard"

/**
 * SPEC 18 — Phase 3. The tenant's own resolved feature map.
 * Returns every catalogued feature with its resolved state (enabled / disabled
 * / limited / metered) and live usage for capacity features. This is the SAME
 * resolution the server guard enforces, so the client can render accurate
 * availability without ever becoming the source of truth for access.
 */
export async function GET() {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const features = await getTenantFeatureMap(auth.tenantId)
  return NextResponse.json({ features })
}
