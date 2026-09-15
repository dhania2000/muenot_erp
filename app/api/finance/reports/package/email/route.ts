import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { hasActionGrant } from "@/lib/permission-store"
import { isEmailConfigured } from "@/lib/email"
import { createFinanceEmail } from "@/lib/finance-email"
import { FINANCE_ONLY_REPORT_MAP } from "@/lib/finance-reports"
import {
  canAccessReport,
  getReportCompany,
  runFinanceReport,
  type ReportViewer,
} from "@/lib/finance-report-run"
import { logReportRun } from "@/lib/finance-report-runs"

// Email a combined CA report package (Phase 60). The PDF itself is built and
// uploaded client-side (identical to the single-report email flow); this route
// regenerates the report list server-side purely to compose an authoritative
// summary body and record the send, then hands the attachment to the finance
// email hub for delivery, tracking and audit.

function esc(v: any): string {
  const s = v === null || v === undefined ? "" : String(v)
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export async function POST(request: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const viewer: ReportViewer = { userId: (session as any).userId, role: session.role }

  const canEmail = await hasActionGrant(viewer.userId, viewer.role, "finance.reports", "email_report")
  if (!canEmail) {
    return NextResponse.json({ error: "You do not have permission to email reports." }, { status: 403 })
  }
  if (!isEmailConfigured("finance")) {
    return NextResponse.json(
      { error: "Finance email is not configured. Add finance mail credentials to send reports." },
      { status: 400 },
    )
  }

  const body = await request.json().catch(() => ({}))
  const keys: string[] = Array.isArray(body.keys) ? body.keys.map(String) : []
  const toEmail = String(body.to_email || "").trim()
  const toName = String(body.to_name || "").trim()
  const message = String(body.message || "").trim()
  const subjectOverride = String(body.subject || "").trim()
  const periodLabel = String(body.period_label || "").trim()
  const from = String(body.from || "")
  const to = String(body.to || "")
  const filters = body.filters && typeof body.filters === "object" ? body.filters : {}

  if (keys.length === 0) return NextResponse.json({ error: "Select at least one report." }, { status: 400 })
  if (!toEmail) return NextResponse.json({ error: "A recipient email is required" }, { status: 400 })

  const attachmentInput =
    body.attachment && typeof body.attachment === "object" && body.attachment.pathname
      ? {
          pathname: String(body.attachment.pathname),
          filename: String(body.attachment.filename || "ca-report-package.pdf"),
          contentType: String(body.attachment.contentType || "application/pdf"),
          size: Number(body.attachment.size) || null,
        }
      : null

  // Regenerate the included report list server-side for an authoritative index.
  const included: Array<{ label: string; group: string; rowCount: number }> = []
  for (const key of keys) {
    const def = FINANCE_ONLY_REPORT_MAP[key]
    if (!def) continue
    if (!(await canAccessReport(viewer, def))) continue
    const run = await runFinanceReport({ reportKey: key, from, to, filters })
    if (!run.ok || !run.reportMeta) continue
    included.push({ label: run.reportMeta.label, group: run.reportMeta.group, rowCount: run.rows.length })
  }

  if (included.length === 0) {
    return NextResponse.json({ error: "None of the selected reports are available to you." }, { status: 403 })
  }

  const company = await getReportCompany()
  const generatedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })

  const indexRows = included
    .map(
      (r, i) =>
        `<tr style="background:${i % 2 ? "#f9fafb" : "#ffffff"};">
          <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;color:#6b7280;">${i + 1}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;color:#111827;">${esc(r.label)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;color:#4b5563;">${esc(r.group)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:right;color:#111827;">${r.rowCount}</td>
        </tr>`,
    )
    .join("")

  const addressHtml = company.addressLines.map((l) => esc(l)).join("<br/>")
  const contactBits = [
    company.taxNumber && `${esc(company.taxLabel)}: ${esc(company.taxNumber)}`,
    company.pan && `PAN: ${esc(company.pan)}`,
    company.email && `Email: ${esc(company.email)}`,
  ]
    .filter(Boolean)
    .join(" &nbsp;•&nbsp; ")

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:820px;margin:0 auto;">
    <div style="border-bottom:3px solid #1f2937;padding-bottom:12px;margin-bottom:16px;">
      <div style="font-size:20px;font-weight:700;">${esc(company.name)}</div>
      ${addressHtml ? `<div style="font-size:12px;color:#4b5563;margin-top:2px;">${addressHtml}</div>` : ""}
      ${contactBits ? `<div style="font-size:12px;color:#4b5563;margin-top:4px;">${contactBits}</div>` : ""}
    </div>
    <div style="text-align:center;margin-bottom:14px;">
      <div style="font-size:17px;font-weight:700;">CA Report Package</div>
      ${periodLabel ? `<div style="font-size:12px;color:#4b5563;margin-top:3px;">${esc(periodLabel)}</div>` : ""}
      <div style="font-size:11px;color:#6b7280;margin-top:3px;">Generated ${esc(generatedAt)} &nbsp;•&nbsp; ${included.length} report${included.length === 1 ? "" : "s"}</div>
    </div>
    ${message ? `<p style="font-size:13px;color:#374151;">${esc(message)}</p>` : ""}
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr>
          <th style="padding:8px 10px;border-bottom:2px solid #1f2937;text-align:left;font-size:11px;text-transform:uppercase;color:#374151;">#</th>
          <th style="padding:8px 10px;border-bottom:2px solid #1f2937;text-align:left;font-size:11px;text-transform:uppercase;color:#374151;">Report</th>
          <th style="padding:8px 10px;border-bottom:2px solid #1f2937;text-align:left;font-size:11px;text-transform:uppercase;color:#374151;">Category</th>
          <th style="padding:8px 10px;border-bottom:2px solid #1f2937;text-align:right;font-size:11px;text-transform:uppercase;color:#374151;">Rows</th>
        </tr>
      </thead>
      <tbody>${indexRows}</tbody>
    </table>
    <p style="font-size:11px;color:#9ca3af;margin-top:18px;">${
      attachmentInput
        ? "The full report package is attached as a single PDF (cover page, company details, report index and each report)."
        : "This summary lists the reports in the package."
    } Figures reflect posted transactions as of the generated time above.</p>
  </div>`

  const subject = subjectOverride || `CA Report Package${periodLabel ? ` — ${periodLabel}` : ""} — ${company.name}`

  const result = await createFinanceEmail({
    toEmail,
    toName: toName || null,
    cc: body.cc ?? null,
    subject,
    body: html,
    category: "Report",
    sourceModule: "financial-reports",
    sourceRecordId: "ca-package",
    emailType: "Manual",
    mode: "send",
    createdBy: viewer.userId ?? null,
    attachment: attachmentInput,
    render: false,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.code || 400 })
  }

  await logReportRun({
    reportKey: "ca-package",
    reportLabel: "CA Report Package",
    format: "Email",
    periodLabel: periodLabel || null,
    filtersText: `${included.length} reports`,
    recipient: toName ? `${toName} <${toEmail}>` : toEmail,
    status: String(result.status || "Sent"),
    userId: viewer.userId ?? null,
    userName: session.name || null,
    rowCount: included.reduce((s, r) => s + r.rowCount, 0),
  })

  return NextResponse.json({ ok: true, id: result.id, email_uid: result.emailUid, status: result.status })
}
