import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, getEmployeeByEmail, getBalanceDetail } from "@/lib/hr-leave"

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const sp = new URL(request.url).searchParams
  const employeeId = Number(sp.get("employee_id"))
  const leaveTypeId = sp.get("leave_type_id")
  const year = Number(sp.get("year"))
  if (!employeeId || !leaveTypeId || !year) {
    return NextResponse.json({ error: "employee_id, leave_type_id and year are required." }, { status: 400 })
  }

  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_balances"))
  if (!canManage) {
    const self = await getEmployeeByEmail(session.email)
    if (!self || Number(self.id) !== employeeId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }

  const detail = await getBalanceDetail(employeeId, leaveTypeId, year)
  if (!detail) return NextResponse.json({ error: "Balance not found" }, { status: 404 })
  return NextResponse.json({ ...detail, canManage })
}
