import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canPerformAction } from "@/lib/permission-enforce"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { financeReport, type FinanceReportView } from "@/lib/operations-finance-report"

const permissionKeys: Record<FinanceReportView, string> = {
  project_cost: "operations.project_cost",
  resource_cost: "operations.resource_cost",
  vendor_cost: "operations.vendor_cost",
  budget_vs_actual: "operations.budget_vs_actual",
}

function isView(value: string | null): value is FinanceReportView {
  return value != null && value in permissionKeys
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const view = new URL(request.url).searchParams.get("view")
  if (!isView(view)) return NextResponse.json({ error: "Invalid report view" }, { status: 400 })

  if (!(await canPerformAction(session, permissionKeys[view], "view"))) {
    return NextResponse.json({ error: "You do not have permission to view this report." }, { status: 403 })
  }

  try {
    await ensureOperationsSchema()
    const rows = await financeReport(view)
    return NextResponse.json({ view, rows })
  } catch (error) {
    console.log("[v0] finance-report failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to build finance report" }, { status: 500 })
  }
}
