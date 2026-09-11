import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, getEmployeeByEmail, validateLeave } from "@/lib/hr-leave"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const body = await request.json()
  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_requests"))

  let employeeId = Number(body.employee_id)
  if (!canManage) {
    const self = await getEmployeeByEmail(session.email)
    if (!self) return NextResponse.json({ error: "No linked employee record." }, { status: 400 })
    employeeId = self.id
  }

  if (!employeeId || !body.leave_type_id || !body.from_date || !body.to_date) {
    return NextResponse.json({ ok: false, errors: [], warnings: [], computation: null }, { status: 200 })
  }

  const validation = await validateLeave({
    employee_id: employeeId,
    leave_type_id: body.leave_type_id,
    from_date: body.from_date,
    to_date: body.to_date,
    is_half_day: Boolean(body.is_half_day),
    half_day_session: body.half_day_session ?? null,
    attachment_url: body.attachment_url ?? null,
    excludeRequestId: body.excludeRequestId ?? undefined,
  })

  return NextResponse.json(validation)
}
