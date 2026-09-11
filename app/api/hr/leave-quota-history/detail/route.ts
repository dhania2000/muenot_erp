import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, getEmployeeByEmail, getQuotaEventDetail } from "@/lib/hr-leave"

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const eventRef = new URL(request.url).searchParams.get("event")
  if (!eventRef) return NextResponse.json({ error: "event is required." }, { status: 400 })

  const detail = await getQuotaEventDetail(eventRef)
  if (!detail) return NextResponse.json({ error: "Ledger event not found." }, { status: 404 })

  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_quota_history"))

  // Self-service users may only inspect their own ledger events.
  if (!canManage) {
    const self = await getEmployeeByEmail(session.email)
    if (!self || Number(self.id) !== Number(detail.event.employee_id)) {
      return NextResponse.json({ error: "You do not have access to this event." }, { status: 403 })
    }
  }

  return NextResponse.json({ ...detail, canManage })
}
