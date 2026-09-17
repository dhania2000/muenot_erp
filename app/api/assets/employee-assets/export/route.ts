import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import { listAssignments, assignmentsToCsv, type AssignmentListParams } from "@/lib/employee-assets"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireModuleAction("assets.employee_assets", "export")
  if (!session) return NextResponse.json({ error: "You do not have permission to export." }, { status: 403 })

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
  const { rows } = await listAssignments(params, session)
  const csv = assignmentsToCsv(rows)
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="employee-assets-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
