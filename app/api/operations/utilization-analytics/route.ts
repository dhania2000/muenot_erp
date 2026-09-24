import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canPerformAction } from "@/lib/permission-enforce"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { utilizationReport } from "@/lib/operations-utilization"

// SPEC 149 — read-only Resource Utilization analytics, derived live from
// approved timesheets, resource capacity and allocations.
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!(await canPerformAction(session, "operations.utilization", "view"))) {
    return NextResponse.json({ error: "You do not have permission to view this report." }, { status: 403 })
  }

  const periodParam = new URL(request.url).searchParams.get("period")
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : undefined

  try {
    await ensureOperationsSchema()
    const report = await utilizationReport({ period })
    return NextResponse.json(report)
  } catch (error) {
    console.log("[v0] utilization-analytics failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to build utilization report" }, { status: 500 })
  }
}
