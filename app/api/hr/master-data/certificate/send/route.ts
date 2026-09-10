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
import { isCertificateKind, loadCertificate, renderCertificatePdf } from "@/lib/hr-certificate"

export const runtime = "nodejs"

function esc(v: string) {
  return String(v).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  )
}

// POST /api/hr/master-data/certificate/send
// body: { kind, id, to?, subject?, message? }
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!isEmailConfigured("hr")) {
    return NextResponse.json({ error: "HR SMTP is not configured" }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const kind = String(body.kind || "")
  const id = body.id
  if (!isCertificateKind(kind)) return NextResponse.json({ error: "Invalid kind" }, { status: 400 })
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })

  const cert = await loadCertificate(kind, id)
  if (!cert) return NextResponse.json({ error: "Record not found" }, { status: 404 })

  const to = String(body.to || cert.recipientEmail || "").trim()
  if (!to) return NextResponse.json({ error: "No recipient email on file" }, { status: 400 })

  const label = kind === "awards" ? "Certificate of Excellence" : "Certificate of Appreciation"
  const subject = String(body.subject || `${label} — ${cert.data.title}`).trim()
  const intro = String(
    body.message ||
      `Dear ${cert.recipientName},\n\nPlease find attached your ${label.toLowerCase()} for "${cert.data.title}". Congratulations and thank you for your contribution.`,
  ).trim()

  const baseUrl = resolveBaseUrl(req)
  const trackingId = generateTrackingToken()
  const html = withTrackingPixel(
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.6">` +
      intro
        .split("\n")
        .map((line) => (line.trim() ? `<p style="margin:0 0 12px">${esc(line)}</p>` : "<br/>"))
        .join("") +
      `<p style="margin:16px 0 0">Regards,<br/>${esc(cert.data.company.name)}</p></div>`,
    baseUrl,
    trackingId,
  ).replace(`/api/track/${trackingId}`, `/api/hr/emails/track/${trackingId}`)

  const pdf = renderCertificatePdf(cert.data)

  try {
    const result = await sendEmail({
      to,
      subject,
      html,
      department: "hr",
      attachments: [{ filename: cert.fileName, content: pdf, contentType: "application/pdf" }],
    })
    await query(
      "INSERT INTO hr_emails (employee_id,to_email,to_name,template_id,subject,body,status,message_id,thread_id) VALUES (?,?,?,?,?,?,?,?,?)",
      [cert.employeeId, to, cert.recipientName, null, subject, intro, "Sent", result.messageId || null, trackingId],
    )
    return NextResponse.json({ ok: true, to })
  } catch (err: any) {
    await query(
      "INSERT INTO hr_emails (employee_id,to_email,to_name,template_id,subject,body,status,thread_id) VALUES (?,?,?,?,?,?,?,?)",
      [cert.employeeId, to, cert.recipientName, null, subject, intro, "Failed", trackingId],
    )
    return NextResponse.json({ error: err?.message || "Failed to send email" }, { status: 500 })
  }
}
