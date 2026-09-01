import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"

const fields = ["employee_name","gender","dob","personal_email","official_email","mobile","alternate_mobile","address","city","state","country","postal_code","emergency_contact_name","emergency_contact_phone","emergency_contact_relation","relative_name","relative_relationship","relative_primary_phone","relative_alternate_phone","relative_email","relative_address","department","designation","reporting_manager","employment_type","joining_date","probation_end_date","confirmation_date","employment_status","onboarding_status","work_location","work_mode","shift","employee_grade","document_status","agreement_status","consent_status","compliance_status","it_access_status","asset_status","training_status","performance_status","notice_period","notice_period_status","exit_status","exit_date","exit_reason","skills","notes"] as const

export async function POST(request: Request) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const rows = Array.isArray(body?.rows) ? body.rows : []
  if (!rows.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 })
  let imported = 0
  const errors: string[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as Record<string, unknown>
    if (!String(row.employee_name || "").trim()) { errors.push(`Row ${index + 2}: employee name is required`); continue }
    try {
      const employeeId = await nextRecordId("EMP")
      const columns = ["employee_id", ...fields]
      const values = [employeeId, ...fields.map((field) => String(row[field] || "").trim() || null), session.userId]
      await query(`INSERT INTO hr_employees (${columns.join(",")}, created_by) VALUES (${columns.map(() => "?").join(",")}, ?)`, values)
      imported++
    } catch { errors.push(`Row ${index + 2}: could not import employee`) }
  }
  return NextResponse.json({ imported, failed: errors.length, errors: errors.slice(0, 20) })
}
