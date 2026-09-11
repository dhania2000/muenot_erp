import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmployeeEventsSchema, logEmployeeEvent } from "@/lib/hr-employee-events"

// Change an employee's employment status and record it as a dedicated
// timeline event. Kept separate from the generic PATCH so the listing/profile
// quick-actions have a focused, auditable endpoint.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const status = String(body.status || "").trim()
  if (!status) return NextResponse.json({ error: "A status value is required" }, { status: 400 })

  const rows = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [id])
  const emp = rows[0]
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  if (emp.employment_status === status) {
    return NextResponse.json({ ok: true, unchanged: true })
  }

  await query("UPDATE hr_employees SET employment_status = ?, status_changed_at = NOW() WHERE id = ?", [status, id])
  await logEmployeeEvent({
    employeeId: Number(id),
    employeeRef: emp.employee_id,
    employeeName: emp.employee_name,
    type: "status_changed",
    summary: `Status changed from ${emp.employment_status || "—"} to ${status}`,
    changes: [{ field: "employment_status", label: "Status", from: emp.employment_status, to: status }],
    actorId: session.userId,
    actorName: session.name,
  })

  return NextResponse.json({ ok: true })
}
