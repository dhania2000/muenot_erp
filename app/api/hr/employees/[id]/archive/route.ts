import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmployeeEventsSchema, logEmployeeEvent } from "@/lib/hr-employee-events"

// Soft-archive: reversible alternative to a hard delete. The record is hidden
// from the default listing but kept for reporting and reactivation.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const { id } = await params
  const rows = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [id])
  const emp = rows[0]
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  if (emp.archived_at) return NextResponse.json({ ok: true, unchanged: true })

  await query("UPDATE hr_employees SET archived_at = NOW(), archived_by = ? WHERE id = ?", [session.userId, id])
  await logEmployeeEvent({
    employeeId: Number(id),
    employeeRef: emp.employee_id,
    employeeName: emp.employee_name,
    type: "archived",
    summary: `Employee ${emp.employee_name} archived`,
    actorId: session.userId,
    actorName: session.name,
  })

  return NextResponse.json({ ok: true })
}
