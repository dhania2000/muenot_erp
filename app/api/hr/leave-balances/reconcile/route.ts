import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, reconcileBalance } from "@/lib/hr-leave"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_balances"))
  if (!canManage) return NextResponse.json({ error: "You do not have permission to reconcile balances." }, { status: 403 })

  await ensureLeaveSchema()
  const body = await request.json().catch(() => ({}))
  const employeeId = Number(body.employee_id)
  const leaveTypeId = Number(body.leave_type_id)
  const year = Number(body.year)
  if (!employeeId || !leaveTypeId || !year) {
    return NextResponse.json({ error: "employee_id, leave_type_id and year are required." }, { status: 400 })
  }

  const reconciliation = await reconcileBalance(employeeId, leaveTypeId, year)
  return NextResponse.json({ ok: true, reconciliation })
}
