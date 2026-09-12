import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import {
  generateTrackingToken,
  isEmailConfigured,
  resolveBaseUrl,
  sendEmail,
  withTrackingPixel,
} from "@/lib/email"
import { userHasFeature } from "@/lib/permissions"
import { getCompanySettings } from "@/lib/hr-letters-db"
import { fileLetterToDocuments, getLetter, letterCompanyFromSettings, letterSignatoryFromSettings } from "@/lib/hr-letters-generate"
import { logLetterEvent } from "@/lib/hr-letters-audit"
import { letterPdfBuffer } from "@/lib/hr-letter-pdf"
import { letterTextToHtml } from "@/lib/hr-letters-render"

export const runtime = "nodejs"

// POST /api/hr/letters/:id/email  body: { to?, subject?, message? }
// Emails the letter as a PDF attachment via the HR transport, logs it into
// hr_emails, links it on the letter, and advances the letter to Delivered.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, "hr.view_letters"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  if (!isEmailConfigured("hr")) {
    return NextResponse.json({ error: "HR email transport is not configured" }, { status: 400 })
  }

  const { id } = await params
  const letter = await getLetter(Number(id))
  if (!letter) return NextResponse.json({ error: "Letter not found" }, { status: 404 })
  if (letter.status === "Cancelled") {
    return NextResponse.json({ error: "A cancelled letter cannot be emailed" }, { status: 422 })
  }

  const body = await request.json().catch(() => ({}))
  const emps = letter.employee_id
    ? await query<any[]>(
        "SELECT official_email, personal_email FROM hr_employees WHERE id = ? LIMIT 1",
        [letter.employee_id],
      )
    : []
  const to = String(body.to || emps[0]?.official_email || emps[0]?.personal_email || "").trim()
  if (!to) return NextResponse.json({ error: "No recipient email on file — provide one" }, { status: 400 })

  const settings = await getCompanySettings()
  const company = letterCompanyFromSettings(settings)
  const subject = String(body.subject || letter.subject || `Letter ${letter.letter_number}`).trim()
  const intro = String(
    body.message ||
      `Dear ${letter.recipient_name || letter.employee_name || "Colleague"},\n\nPlease find attached your letter (Ref: ${letter.letter_number}).\n\nRegards,\n${company.name}`,
  ).trim()

  const pdf = letterPdfBuffer({
    letterNumber: letter.letter_number,
    referenceNo: letter.reference_no || null,
    subject: letter.subject,
    body: letter.body,
    issueDate: letter.issue_date,
    recipientName: letter.recipient_name || letter.employee_name || null,
    recipientMeta:
      [letter.employee_code, [letter.designation, letter.department].filter(Boolean).join(", ")]
        .filter(Boolean)
        .join(" · ") || null,
    company,
    signatory: letterSignatoryFromSettings(settings),
  })

  const baseUrl = resolveBaseUrl(request)
  const token = generateTrackingToken()
  const html = withTrackingPixel(letterTextToHtml(intro), baseUrl, token).replace(
    `/api/track/${token}`,
    `/api/hr/emails/track/${token}`,
  )
  const safeName = (letter.recipient_name || letter.employee_name || "letter").replace(/[^a-z0-9]+/gi, "-")

  try {
    const result = await sendEmail({
      to,
      subject,
      html,
      department: "hr",
      attachments: [{ filename: `${letter.letter_number}-${safeName}.pdf`, content: pdf, contentType: "application/pdf" }],
    })
    const inserted = await query<any>(
      `INSERT INTO hr_emails (employee_id, to_email, to_name, template_id, subject, body, status, message_id, thread_id, category, source_module, source_record_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        letter.employee_id,
        to,
        letter.recipient_name || letter.employee_name || null,
        null,
        subject,
        intro,
        "Sent",
        result.messageId || null,
        token,
        "Letters",
        "letters",
        letter.letter_number,
        session.userId,
      ],
    ).catch(() => null)

    await query(
      `UPDATE hr_letters
         SET status = CASE WHEN status IN ('Draft','Generated','Issued') THEN 'Delivered' ELSE status END,
             email_id = ?, delivered_at = COALESCE(delivered_at, NOW()), issued_at = COALESCE(issued_at, NOW())
       WHERE id = ?`,
      [inserted ? Number((inserted as any).insertId) : null, letter.id],
    )

    await logLetterEvent({
      letterId: letter.id,
      letterNumber: letter.letter_number,
      type: "emailed",
      summary: `Emailed to ${to}`,
      detail: { to, subject, message_id: result.messageId || null },
      actorId: session.userId,
      actorName: session.name ?? null,
    })

    // Emailed letters are delivered records — persist the PDF to the vault.
    await fileLetterToDocuments(letter.id, session.userId)

    return NextResponse.json({ ok: true, to })
  } catch (error: any) {
    await query(
      `INSERT INTO hr_emails (employee_id, to_email, to_name, subject, body, status, thread_id, category, source_module, source_record_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        letter.employee_id,
        to,
        letter.recipient_name || letter.employee_name || null,
        subject,
        intro,
        "Failed",
        token,
        "Letters",
        "letters",
        letter.letter_number,
        session.userId,
      ],
    ).catch(() => {})
    return NextResponse.json({ error: error?.message || "Failed to send email" }, { status: 500 })
  }
}
