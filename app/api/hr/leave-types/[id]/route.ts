import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getLeaveTypeByBusinessId,
  getLeaveTypeUsage,
  listLeaveTypeAudit,
  leaveTypeInUse,
} from "@/lib/hr-leave"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const type = await getLeaveTypeByBusinessId(id)
  if (!type) return NextResponse.json({ error: "Leave type not found" }, { status: 404 })

  const year = new Date().getFullYear()
  const [usage, audit, inUse] = await Promise.all([
    getLeaveTypeUsage(type, year),
    listLeaveTypeAudit(type.leave_type_id, 50),
    leaveTypeInUse(type),
  ])

  return NextResponse.json({ leaveType: type, usage, audit, inUse, year })
}
