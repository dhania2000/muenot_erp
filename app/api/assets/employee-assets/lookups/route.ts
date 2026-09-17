import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listAvailableAssets, listEmployees } from "@/lib/employee-assets"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_employee_assets")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = req.nextUrl.searchParams
  const [assets, employees] = await Promise.all([
    listAvailableAssets(sp.get("asset_search")),
    listEmployees(sp.get("employee_search")),
  ])
  return NextResponse.json({ assets, employees })
}
