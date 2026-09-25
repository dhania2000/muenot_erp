import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { createMaintenance, listMaintenance, AssetLifecycleError } from "@/lib/asset-lifecycle"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_employee_assets")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = req.nextUrl.searchParams
  const rows = await listMaintenance({ asset_id: sp.get("asset_id"), status: sp.get("status") })
  return NextResponse.json({ rows })
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction("assets.employee_assets", "create")
  if (!session)
    return NextResponse.json({ error: "You do not have permission to log maintenance." }, { status: 403 })
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await createMaintenance(body, session)
    return NextResponse.json(detail, { status: 201 })
  } catch (error) {
    if (error instanceof AssetLifecycleError)
      return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] create maintenance failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to log maintenance." }, { status: 500 })
  }
}
