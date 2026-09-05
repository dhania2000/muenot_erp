import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"

async function access() {
  const session = await getSession()
  if (!session) return null
  if (session.role === "admin") return session
  const granted = await query<any[]>(`SELECT 1 FROM user_permissions up JOIN features f ON f.id=up.feature_id WHERE up.user_id=? AND f.slug='hr.view_employees' LIMIT 1`, [session.userId])
  return granted.length ? session : null
}

export async function GET() {
  const session = await access()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const employees = await query("SELECT * FROM hr_employees ORDER BY created_at DESC")
  return NextResponse.json({ employees })
}

export async function POST(request: Request) {
  const session = await access()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json()
  if (!body.employee_name) return NextResponse.json({ error: "Employee name is required" }, { status: 400 })
  const employeeId = await nextRecordId("EMP")
  const allowed = new Set(["employee_id","employee_name","gender","dob","personal_email","official_email","mobile","alternate_mobile","address","city","state","country","postal_code","emergency_contact_name","emergency_contact_phone","emergency_contact_relation","relative_name","relative_relationship","relative_primary_phone","relative_alternate_phone","relative_email","relative_address","department","designation","reporting_manager","employment_type","joining_date","probation_end_date","confirmation_date","employment_status","onboarding_status","work_location","work_mode","shift","employee_grade","document_status","agreement_status","consent_status","compliance_status","it_access_status","asset_status","training_status","performance_status","notice_period","notice_period_status","exit_status","exit_date","exit_reason","skills","notes","bank_account_holder_name","bank_name","bank_account_number","bank_ifsc_code","bank_branch","bank_account_type","bank_swift_code","bank_pan_number","bank_upi_id","photo_url"])
  const fields = Object.keys(body).filter((key) => allowed.has(key) && key !== "employee_id")
  fields.unshift("employee_id")
  const values = fields.map((key) => key === "employee_id" ? employeeId : body[key] === "" ? null : body[key])
  await query(`INSERT INTO hr_employees (${fields.join(",")},created_by) VALUES (${fields.map(() => "?").join(",")},?)`, [...values, session.userId])
  return NextResponse.json({ ok: true }, { status: 201 })
}
