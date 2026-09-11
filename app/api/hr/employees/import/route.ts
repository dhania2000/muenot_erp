import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { ensureEmployeeEventsSchema, logEmployeeEvent, recordImportRun } from "@/lib/hr-employee-events"

const fields = ["employee_name","gender","dob","personal_email","official_email","mobile","alternate_mobile","address","city","state","country","postal_code","emergency_contact_name","emergency_contact_phone","emergency_contact_relation","relative_name","relative_relationship","relative_primary_phone","relative_alternate_phone","relative_email","relative_address","department","designation","reporting_manager","employment_type","joining_date","probation_end_date","confirmation_date","employment_status","onboarding_status","work_location","work_mode","shift","employee_grade","document_status","agreement_status","consent_status","compliance_status","it_access_status","asset_status","training_status","performance_status","notice_period","notice_period_status","exit_status","exit_date","exit_reason","skills","notes"] as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request) {
  const session = await requireFeature("hr.manage_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const body = await request.json().catch(() => ({}))
  const rows = Array.isArray(body?.rows) ? body.rows : []
  const fileName = typeof body?.fileName === "string" ? body.fileName : null
  if (!rows.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 })

  // Preload existing official emails/mobiles for duplicate detection.
  const existing = await query<{ official_email: string | null; personal_email: string | null; mobile: string | null }[]>(
    "SELECT official_email, personal_email, mobile FROM hr_employees",
  )
  const existingEmails = new Set(
    existing.flatMap((r) => [r.official_email, r.personal_email]).filter(Boolean).map((v) => String(v).toLowerCase()),
  )
  const existingMobiles = new Set(existing.map((r) => r.mobile).filter(Boolean).map((v) => String(v)))

  // Track duplicates *within* the uploaded file as well.
  const seenEmails = new Set<string>()
  const seenMobiles = new Set<string>()

  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index++) {
    const rowNum = index + 2 // account for the header row in the spreadsheet
    const row = rows[index] as Record<string, unknown>
    const name = String(row.employee_name || "").trim()

    if (!name) {
      errors.push(`Row ${rowNum}: employee name is required`)
      continue
    }

    const email = String(row.official_email || "").trim().toLowerCase()
    const personalEmail = String(row.personal_email || "").trim().toLowerCase()
    const mobile = String(row.mobile || "").trim()

    // Validation.
    if (email && !EMAIL_RE.test(email)) {
      errors.push(`Row ${rowNum}: invalid official email "${row.official_email}"`)
      continue
    }
    if (personalEmail && !EMAIL_RE.test(personalEmail)) {
      errors.push(`Row ${rowNum}: invalid personal email "${row.personal_email}"`)
      continue
    }

    // Duplicate detection (existing records + earlier rows in this file).
    const emailToCheck = email || personalEmail
    if (emailToCheck && (existingEmails.has(emailToCheck) || seenEmails.has(emailToCheck))) {
      skipped++
      errors.push(`Row ${rowNum}: skipped — email "${emailToCheck}" already exists`)
      continue
    }
    if (mobile && (existingMobiles.has(mobile) || seenMobiles.has(mobile))) {
      skipped++
      errors.push(`Row ${rowNum}: skipped — mobile "${mobile}" already exists`)
      continue
    }

    try {
      const employeeId = await nextRecordId("EMP")
      const columns = ["employee_id", ...fields]
      const values = [employeeId, ...fields.map((field) => String(row[field] || "").trim() || null), session.userId]
      const result = await query<any>(
        `INSERT INTO hr_employees (${columns.join(",")}, created_by) VALUES (${columns.map(() => "?").join(",")}, ?)`,
        values,
      )
      imported++
      if (emailToCheck) seenEmails.add(emailToCheck)
      if (mobile) seenMobiles.add(mobile)

      await logEmployeeEvent({
        employeeId: Number(result.insertId),
        employeeRef: employeeId,
        employeeName: name,
        type: "imported",
        summary: `Imported${fileName ? ` from ${fileName}` : ""}`,
        actorId: session.userId,
        actorName: session.name,
      })
    } catch {
      errors.push(`Row ${rowNum}: could not import employee`)
    }
  }

  const failed = errors.filter((e) => !e.includes("skipped")).length

  await recordImportRun({
    fileName,
    totalRows: rows.length,
    imported,
    failed,
    skipped,
    errors: errors.slice(0, 100),
    actorId: session.userId,
    actorName: session.name,
  })

  return NextResponse.json({
    imported,
    failed,
    skipped,
    total: rows.length,
    errors: errors.slice(0, 50),
  })
}
