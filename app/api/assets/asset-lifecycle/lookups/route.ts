import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listAssetOptions } from "@/lib/asset-lifecycle"
import { WARRANTY_TYPES, MAINTENANCE_TYPES, MAINTENANCE_STATUSES } from "@/lib/asset-lifecycle-model"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_employee_assets")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const assets = await listAssetOptions(req.nextUrl.searchParams.get("search"))
  return NextResponse.json({
    assets,
    warranty_types: WARRANTY_TYPES,
    maintenance_types: MAINTENANCE_TYPES,
    maintenance_statuses: MAINTENANCE_STATUSES,
  })
}
