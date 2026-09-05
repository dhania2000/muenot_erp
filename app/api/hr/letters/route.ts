import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { ensureLetterTables, getCompanySettings } from "@/lib/hr-letters-db"
import { renderLetter } from "@/lib/hr-letters"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const letters = await query<any[]>(
    `SELECT l.*, e.employee_name, e.employee_id AS employee_code, e.designation, e.department
     FROM hr_letters l JOIN hr_employees e ON e.id = l.employee_id
     ORDER BY l.created_at DESC`,
  )
  return NextResponse.json({ letters })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const body = await request.json()
  if (!body.employee_id || !body.subject || !body.body) {
    return NextResponse.json({ error: "Employee, subject and body are required" }, { status: 400 })
  }

  const employees = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [body.employee_id])
  const employee = employees[0]
  if (!employee) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  const letterNumber = await nextRecordId("LTR")
  const company = await getCompanySettings()
  const ctx = { employee, company, letter_number: letterNumber }

  // Store the rendered snapshot so the letter stays fixed even if the
  // employee record or company settings change later.
  const subject = renderLetter(body.subject, ctx)
  const renderedBody = renderLetter(body.body, ctx)
  const issueDate = body.issue_date || new Date().toISOString().slice(0, 10)
  const status = body.status === "Issued" ? "Issued" : "Draft"

  const result = await query<any>(
    `INSERT INTO hr_letters (letter_number, employee_id, template_id, letter_type, subject, body, issue_date, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [letterNumber, body.employee_id, body.template_id || null, body.letter_type || "Offer Letter", subject, renderedBody, issueDate, status, session.userId],
  )
  return NextResponse.json({ id: result.insertId, letter_number: letterNumber }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "ID is required" }, { status: 400 })
  const editable = ["subject", "body", "letter_type", "issue_date", "status"] as const
  const updates = editable.filter((field) => Object.prototype.hasOwnProperty.call(body, field))
  if (!updates.length) return NextResponse.json({ error: "No changes provided" }, { status: 400 })
  await query(
    `UPDATE hr_letters SET ${updates.map((field) => `${field} = ?`).join(", ")} WHERE id = ?`,
    [...updates.map((field) => body[field]), body.id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const id = new URL(request.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "ID is required" }, { status: 400 })
  await query("DELETE FROM hr_letters WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
