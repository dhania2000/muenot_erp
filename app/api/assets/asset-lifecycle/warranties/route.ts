import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { createWarranty, listWarranties, AssetLifecycleError } from "@/lib/asset-lifecycle"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_employee_assets")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const rows = await listWarranties({ asset_id: req.nextUrl.searchParams.get("asset_id") })
  return NextResponse.json({ rows })
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction("assets.employee_assets", "create")
  if (!session)
    return NextResponse.json({ error: "You do not have permission to add warranties." }, { status: 403 })
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await createWarranty(body, session)
    return NextResponse.json(detail, { status: 201 })
  } catch (error) {
    if (error instanceof AssetLifecycleError)
      return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] create warranty failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to save warranty." }, { status: 500 })
  }
}
