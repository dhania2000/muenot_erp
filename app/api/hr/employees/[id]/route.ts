import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

const ALLOWED = new Set([
  "employee_name","gender","dob","personal_email","official_email","mobile","alternate_mobile","address","city","state","country","postal_code","emergency_contact_name","emergency_contact_phone","emergency_contact_relation","relative_name","relative_relationship","relative_primary_phone","relative_alternate_phone","relative_email","relative_address","department","designation","reporting_manager","employment_type","joining_date","probation_end_date","confirmation_date","employment_status","onboarding_status","work_location","work_mode","shift","employee_grade","document_status","agreement_status","consent_status","compliance_status","it_access_status","asset_status","training_status","performance_status","notice_period","notice_period_status","exit_status","exit_date","exit_reason","skills","notes","bank_account_holder_name","bank_name","bank_account_number","bank_ifsc_code","bank_branch","bank_account_type","bank_swift_code","bank_pan_number","bank_upi_id","photo_url",
])

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json()
  if (body.employee_name !== undefined && !body.employee_name) {
    return NextResponse.json({ error: "Employee name is required" }, { status: 400 })
  }
  const fields = Object.keys(body).filter((key) => ALLOWED.has(key))
  if (fields.length === 0) return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
  const values = fields.map((key) => (body[key] === "" ? null : body[key]))
  const existing = await query<any[]>("SELECT id FROM hr_employees WHERE id = ? LIMIT 1", [id])
  if (!existing.length) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  await query(`UPDATE hr_employees SET ${fields.map((key) => `${key}=?`).join(",")} WHERE id = ?`, [...values, id])
  return NextResponse.json({ ok: true })
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const existing = await query<any[]>("SELECT id FROM hr_employees WHERE id = ? LIMIT 1", [id])
  if (!existing.length) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  await query("DELETE FROM hr_employees WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
