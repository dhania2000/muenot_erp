import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmployeeEventsSchema, logEmployeeEvent } from "@/lib/hr-employee-events"

// Reverse a soft-archive, returning the employee to the active roster.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const { id } = await params
  const rows = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [id])
  const emp = rows[0]
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  if (!emp.archived_at) return NextResponse.json({ ok: true, unchanged: true })

  await query("UPDATE hr_employees SET archived_at = NULL, archived_by = NULL WHERE id = ?", [id])
  await logEmployeeEvent({
    employeeId: Number(id),
    employeeRef: emp.employee_id,
    employeeName: emp.employee_name,
    type: "reactivated",
    summary: `Employee ${emp.employee_name} reactivated`,
    actorId: session.userId,
    actorName: session.name,
  })

  return NextResponse.json({ ok: true })
}
