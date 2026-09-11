import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmployeeEventsSchema, logEmployeeEvent } from "@/lib/hr-employee-events"

type BulkAction = "set_status" | "archive" | "reactivate" | "set_department" | "set_manager" | "set_shift"

// Apply an action to many employees at once. Each affected row gets its own
// audit event so the per-employee timeline stays complete.
export async function POST(request: Request) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const body = await request.json().catch(() => ({}))
  const action = body.action as BulkAction
  const value = body.value !== undefined && body.value !== "" ? String(body.value) : null
  const ids = Array.isArray(body.ids) ? body.ids.map((x: any) => Number(x)).filter(Boolean) : []

  if (!ids.length) return NextResponse.json({ error: "No employees selected" }, { status: 400 })
  const valueActions: BulkAction[] = ["set_status", "set_department", "set_manager", "set_shift"]
  if (valueActions.includes(action) && !value) {
    return NextResponse.json({ error: "A value is required for this action" }, { status: 400 })
  }

  const placeholders = ids.map(() => "?").join(",")
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, employment_status, department, reporting_manager, shift, archived_at
       FROM hr_employees WHERE id IN (${placeholders})`,
    ids,
  )
  if (!rows.length) return NextResponse.json({ error: "No matching employees" }, { status: 404 })

  let affected = 0
  for (const emp of rows) {
    let summary = ""
    switch (action) {
      case "set_status":
        if (emp.employment_status === value) continue
        await query("UPDATE hr_employees SET employment_status = ?, status_changed_at = NOW() WHERE id = ?", [value, emp.id])
        summary = `Status set to ${value} (bulk)`
        break
      case "archive":
        if (emp.archived_at) continue
        await query("UPDATE hr_employees SET archived_at = NOW(), archived_by = ? WHERE id = ?", [session.userId, emp.id])
        summary = "Archived (bulk)"
        break
      case "reactivate":
        if (!emp.archived_at) continue
        await query("UPDATE hr_employees SET archived_at = NULL, archived_by = NULL WHERE id = ?", [emp.id])
        summary = "Reactivated (bulk)"
        break
      case "set_department":
        if (emp.department === value) continue
        await query("UPDATE hr_employees SET department = ? WHERE id = ?", [value, emp.id])
        summary = `Department set to ${value} (bulk)`
        break
      case "set_manager":
        if (emp.reporting_manager === value) continue
        await query("UPDATE hr_employees SET reporting_manager = ? WHERE id = ?", [value, emp.id])
        summary = `Reporting manager set to ${value} (bulk)`
        break
      case "set_shift":
        if (emp.shift === value) continue
        await query("UPDATE hr_employees SET shift = ? WHERE id = ?", [value, emp.id])
        summary = `Shift set to ${value} (bulk)`
        break
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }

    affected++
    await logEmployeeEvent({
      employeeId: Number(emp.id),
      employeeRef: emp.employee_id,
      employeeName: emp.employee_name,
      type: action === "archive" ? "archived" : action === "reactivate" ? "reactivated" : "bulk_updated",
      summary,
      actorId: session.userId,
      actorName: session.name,
    })
  }

  return NextResponse.json({ ok: true, affected, requested: ids.length })
}
