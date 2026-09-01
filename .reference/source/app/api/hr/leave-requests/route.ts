import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const rows = await query<any[]>("SELECT * FROM hr_leave_requests ORDER BY requested_at DESC")
  return NextResponse.json({ requests: rows })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  const from = new Date(body.from_date), to = new Date(body.to_date)
  if (!body.employee_id || !body.leave_type_id || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return NextResponse.json({ error: "Invalid leave details" }, { status: 400 })
  const days = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1
  const requestId = `LR-${Date.now().toString(36).toUpperCase()}`
  await query("INSERT INTO hr_leave_requests (request_id,employee_id,employee_name,leave_type_id,from_date,to_date,days,reason,attachment_url,manager_id,hr_reviewer_id,remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [requestId, body.employee_id, body.employee_name || "", body.leave_type_id, body.from_date, body.to_date, days, body.reason || "", body.attachment_url || null, body.manager_id || null, body.hr_reviewer_id || null, body.remarks || null])
  return NextResponse.json({ request_id: requestId }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id, status, remarks, manager_id, hr_reviewer_id } = await request.json()
  if (!id || !status) return NextResponse.json({ error: "Missing update details" }, { status: 400 })
  await query("UPDATE hr_leave_requests SET status=?, remarks=COALESCE(?,remarks), manager_id=COALESCE(?,manager_id), hr_reviewer_id=COALESCE(?,hr_reviewer_id), manager_action_at=IF(? IN ('Manager Approved','Manager Rejected'),CURRENT_TIMESTAMP,manager_action_at), hr_action_at=IF(? IN ('HR Approved','HR Rejected'),CURRENT_TIMESTAMP,hr_action_at) WHERE id=?", [status, remarks || null, manager_id || null, hr_reviewer_id || null, status, status, id])
  return NextResponse.json({ ok: true })
}
