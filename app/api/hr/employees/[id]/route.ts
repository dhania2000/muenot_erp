import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureEmployeeEventsSchema,
  logEmployeeEvent,
  diffEmployee,
  fieldLabel,
} from "@/lib/hr-employee-events"

const ALLOWED = new Set([
  "employee_name","gender","dob","personal_email","official_email","mobile","alternate_mobile","address","city","state","country","postal_code","emergency_contact_name","emergency_contact_phone","emergency_contact_relation","relative_name","relative_relationship","relative_primary_phone","relative_alternate_phone","relative_email","relative_address","department","designation","reporting_manager","employment_type","joining_date","probation_end_date","confirmation_date","employment_status","onboarding_status","work_location","work_mode","shift","employee_grade","document_status","agreement_status","consent_status","compliance_status","it_access_status","asset_status","training_status","performance_status","notice_period","notice_period_status","exit_status","exit_date","exit_reason","skills","notes","bank_account_holder_name","bank_name","bank_account_number","bank_ifsc_code","bank_branch","bank_account_type","bank_swift_code","bank_pan_number","bank_upi_id","photo_url",
])

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()
  const { id } = await params
  const body = await request.json()
  if (body.employee_name !== undefined && !body.employee_name) {
    return NextResponse.json({ error: "Employee name is required" }, { status: 400 })
  }
  const fields = Object.keys(body).filter((key) => ALLOWED.has(key))
  if (fields.length === 0) return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })

  const existingRows = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [id])
  const existing = existingRows[0]
  if (!existing) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  const next: Record<string, unknown> = {}
  for (const key of fields) next[key] = body[key] === "" ? null : body[key]
  const changes = diffEmployee(existing, next)

  const values = fields.map((key) => next[key])
  await query(`UPDATE hr_employees SET ${fields.map((key) => `${key}=?`).join(",")} WHERE id = ?`, [...values, id])

  if (changes.length) {
    // A status change gets its own event type so the timeline can highlight it.
    const statusChange = changes.find((c) => c.field === "employment_status")
    if (statusChange) {
      await query("UPDATE hr_employees SET status_changed_at = NOW() WHERE id = ?", [id])
      await logEmployeeEvent({
        employeeId: Number(id),
        employeeRef: existing.employee_id,
        employeeName: existing.employee_name,
        type: "status_changed",
        summary: `Status changed from ${statusChange.from || "—"} to ${statusChange.to || "—"}`,
        changes,
        actorId: session.userId,
        actorName: session.name,
      })
    } else {
      const labels = changes.map((c) => fieldLabel(c.field)).slice(0, 6).join(", ")
      await logEmployeeEvent({
        employeeId: Number(id),
        employeeRef: existing.employee_id,
        employeeName: existing.employee_name,
        type: "updated",
        summary: `Updated ${labels}${changes.length > 6 ? "…" : ""}`,
        changes,
        actorId: session.userId,
        actorName: session.name,
      })
    }
  }

  return NextResponse.json({ ok: true, changed: changes.length })
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Hard delete is destructive and stays admin-only. Archiving is the
  // recommended reversible path (see the /archive route).
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()
  const { id } = await params
  const existingRows = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [id])
  const existing = existingRows[0]
  if (!existing) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  await query("DELETE FROM hr_employees WHERE id = ?", [id])

  // The event log intentionally has no FK, so this trail survives the delete.
  await logEmployeeEvent({
    employeeId: Number(id),
    employeeRef: existing.employee_id,
    employeeName: existing.employee_name,
    type: "deleted",
    summary: `Employee ${existing.employee_name} (${existing.employee_id}) permanently deleted`,
    actorId: session.userId,
    actorName: session.name,
  })

  return NextResponse.json({ ok: true })
}
