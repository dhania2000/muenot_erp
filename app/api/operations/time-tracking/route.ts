import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canPerformAction } from "@/lib/permission-enforce"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { timeTrackingReport } from "@/lib/operations-time-tracking"

// SPEC 148 — read-only Time Tracking analytics, derived live from
// operations_timesheets (project time, client time, billable/non-billable,
// approval workflow state, overtime, and payroll/billing roll-ups).
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!(await canPerformAction(session, "operations.timesheets", "view"))) {
    return NextResponse.json({ error: "You do not have permission to view this report." }, { status: 403 })
  }

  const url = new URL(request.url)
  const periodParam = url.searchParams.get("period")
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : undefined
  // Default to approved-only so payroll/billing reconciles to approved timesheets;
  // callers can pass ?scope=all to include Draft/Submitted/Rejected in roll-ups.
  const approvedOnly = url.searchParams.get("scope") !== "all"

  try {
    await ensureOperationsSchema()
    const report = await timeTrackingReport({ period, approvedOnly })
    return NextResponse.json(report)
  } catch (error) {
    console.log("[v0] time-tracking analytics failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to build time tracking report" }, { status: 500 })
  }
}
