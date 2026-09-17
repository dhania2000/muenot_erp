import "server-only"
import { sendEmail } from "@/lib/email"
import { getEsignFile, logEsignEvent } from "@/lib/legal-esign"
import type { EsignRequest, EsignSigner } from "@/lib/legal-esign-shared"

// ---------------------------------------------------------------------------
// Legal E-sign — email delivery (server-only).
//
// Thin wrapper over the existing ERP email engine (lib/email.ts) — it never
// spins up a second mail transport (Phase 28). It builds the signing-request
// and signed-document messages and records a Sent / Failed audit entry with the
// provider message id where available (Phase 58).
// ---------------------------------------------------------------------------

function appBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "http://localhost:3000"
  return raw.replace(/\/$/, "")
}

export function buildSignUrl(rawToken: string): string {
  return `${appBaseUrl()}/esign/sign/${rawToken}`
}

function shell(title: string, bodyHtml: string): string {
  return `<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <div style="padding:20px 0;border-bottom:2px solid #1e3a5f">
      <span style="font-size:18px;font-weight:700;color:#1e3a5f">Muenot</span>
      <span style="font-size:12px;color:#64748b;margin-left:8px">Electronic Signature</span>
    </div>
    <h2 style="font-size:18px;margin:24px 0 12px">${title}</h2>
    ${bodyHtml}
    <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">
      This is an automated message from Muenot ERP. If you were not expecting this document, please ignore this email.
    </p>
  </div>`
}

/** Send (or resend) a signing invitation to a single signer with a secure link. */
export async function sendSigningRequestEmail(input: {
  request: EsignRequest
  signer: EsignSigner
  rawToken: string
  senderName?: string | null
  senderUserId?: number | null
  resend?: boolean
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { request, signer, rawToken } = input
  if (!signer.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(signer.email)) {
    await logEsignEvent({
      requestId: request.id,
      signerId: signer.id,
      type: "email_failed",
      summary: `Signing email not sent — missing/invalid email for ${signer.name}`,
    })
    return { ok: false, error: "Signer has no valid email address" }
  }

  const url = buildSignUrl(rawToken)
  const due = request.due_date
    ? new Date(request.due_date).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    : null
  const sender = input.senderName || request.created_by_name || "Muenot"

  const body = `
    <p style="font-size:14px;line-height:1.6">Dear ${signer.name},</p>
    <p style="font-size:14px;line-height:1.6">
      ${sender} has requested your signature on <strong>${request.title}</strong>${
        signer.role ? ` as <strong>${signer.role}</strong>` : ""
      }.
    </p>
    ${due ? `<p style="font-size:14px;line-height:1.6">Please sign on or before <strong>${due}</strong>.</p>` : ""}
    ${request.message ? `<p style="font-size:14px;line-height:1.6;background:#f8fafc;padding:12px;border-radius:8px">${request.message}</p>` : ""}
    <p style="margin:28px 0">
      <a href="${url}" style="background:#1e3a5f;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;display:inline-block">
        Review &amp; Sign Document
      </a>
    </p>
    <p style="font-size:12px;color:#64748b">Or paste this secure link into your browser:<br/><span style="word-break:break-all">${url}</span></p>
  `

  try {
    const res = await sendEmail({
      to: signer.email,
      subject: `${input.resend ? "Reminder: " : ""}Signature requested — ${request.title}`,
      html: shell(input.resend ? "Reminder: your signature is requested" : "Your signature is requested", body),
      department: "Legal" as any,
      senderUserId: input.senderUserId ?? null,
    })
    await logEsignEvent({
      requestId: request.id,
      signerId: signer.id,
      type: input.resend ? "request_resent" : "request_sent",
      summary: `${input.resend ? "Resent" : "Sent"} signing request to ${signer.name} <${signer.email}>`,
      detail: { messageId: res.messageId ?? null, recipient: signer.email },
    })
    return { ok: true, messageId: res.messageId }
  } catch (error) {
    const msg = (error as Error).message
    await logEsignEvent({
      requestId: request.id,
      signerId: signer.id,
      type: "email_failed",
      summary: `Failed to send signing request to ${signer.name}: ${msg}`,
      detail: { recipient: signer.email },
    })
    return { ok: false, error: msg }
  }
}

/** Email the final signed PDF to a recipient with the document attached. */
export async function sendSignedDocumentEmail(input: {
  request: EsignRequest
  to: string
  recipientName?: string | null
  senderName?: string | null
  senderUserId?: number | null
  actorId?: number | null
  actorName?: string | null
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { request, to } = input
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: "Invalid recipient email address" }
  }
  if (!request.signed_file_id) return { ok: false, error: "No signed document available yet" }

  const file = await getEsignFile(request.signed_file_id)
  if (!file) return { ok: false, error: "Signed document could not be loaded" }

  const body = `
    <p style="font-size:14px;line-height:1.6">Dear ${input.recipientName || "Recipient"},</p>
    <p style="font-size:14px;line-height:1.6">
      Please find attached the fully executed document <strong>${request.title}</strong>
      (Reference ${request.contract_reference || request.request_uid}).
    </p>
    <p style="font-size:14px;line-height:1.6">All required signatures have been collected.</p>
  `
  try {
    const res = await sendEmail({
      to,
      subject: `Signed document — ${request.title}`,
      html: shell("Your signed document", body),
      department: "Legal" as any,
      senderUserId: input.senderUserId ?? null,
      attachments: [
        {
          filename: file.filename || `${request.request_uid}-signed.pdf`,
          content: file.data,
          contentType: "application/pdf",
        },
      ],
    })
    await logEsignEvent({
      requestId: request.id,
      type: "signed_pdf_emailed",
      summary: `Signed PDF emailed to ${to}`,
      detail: { messageId: res.messageId ?? null, recipient: to },
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
    })
    return { ok: true, messageId: res.messageId }
  } catch (error) {
    const msg = (error as Error).message
    await logEsignEvent({
      requestId: request.id,
      type: "email_failed",
      summary: `Failed to email signed PDF to ${to}: ${msg}`,
      detail: { recipient: to },
      actorId: input.actorId ?? null,
    })
    return { ok: false, error: msg }
  }
}
