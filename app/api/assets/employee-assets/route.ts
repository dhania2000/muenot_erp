import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { assignAsset, listAssignments, AssetAssignmentError, type AssignmentListParams } from "@/lib/employee-assets"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_employee_assets")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const params: AssignmentListParams = {
    search: sp.get("search"),
    status: sp.get("status"),
    employee_id: sp.get("employee_id"),
    department: sp.get("department"),
    asset_type: sp.get("asset_type"),
    date_from: sp.get("date_from"),
    date_to: sp.get("date_to"),
    return_from: sp.get("return_from"),
    return_to: sp.get("return_to"),
    pending_recovery: sp.get("pending_recovery") === "1",
  }
  const data = await listAssignments(params, session)
  return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction("assets.employee_assets", "assign")
  if (!session) return NextResponse.json({ error: "You do not have permission to assign assets." }, { status: 403 })
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await assignAsset(body, session)
    return NextResponse.json(detail, { status: 201 })
  } catch (error) {
    if (error instanceof AssetAssignmentError)
      return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] assign asset failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to assign asset." }, { status: 500 })
  }
}
