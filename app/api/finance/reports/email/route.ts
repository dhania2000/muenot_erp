import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { isEmailConfigured } from "@/lib/email"
import { createFinanceEmail } from "@/lib/finance-email"
import { getReportCompany, runFinanceReport } from "@/lib/finance-report-run"
import { logReportRun } from "@/lib/finance-report-runs"
import { inr0 } from "@/lib/finance-calc"

// Email a Financial Report. Reuses the shared report engine to regenerate the
// rows server-side (so the recipient always gets fresh, authoritative numbers
// rather than whatever the browser happened to have) and the finance email hub
// for delivery, tracking and audit — no bespoke report engine or mailer here.

const money = (n: any) => inr0(Number(n) || 0)

function esc(v: any): string {
  const s = v === null || v === undefined ? "" : String(v)
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function cell(value: any, col: { money?: boolean }) {
  if (value === null || value === undefined || value === "") return ""
  return col.money ? money(value) : esc(value)
}

export async function POST(request: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  if (!isEmailConfigured("finance")) {
    return NextResponse.json(
      { error: "Finance email is not configured. Add finance mail credentials to send reports." },
      { status: 400 },
    )
  }

  const body = await request.json().catch(() => ({}))
  const reportKey = String(body.report || "").trim()
  const toEmail = String(body.to_email || "").trim()
  const toName = String(body.to_name || "").trim()
  const subtitle = String(body.subtitle || "").trim()
  const message = String(body.message || "").trim()
  const subjectOverride = String(body.subject || "").trim()
  const periodLabel = String(body.period_label || "").trim()
  const filtersText = String(body.filters_text || "").trim()

  // Optional PDF snapshot to attach (uploaded client-side to email-attachments).
  const attachmentInput =
    body.attachment && typeof body.attachment === "object" && body.attachment.pathname
      ? {
          pathname: String(body.attachment.pathname),
          filename: String(body.attachment.filename || "report.pdf"),
          contentType: String(body.attachment.contentType || "application/pdf"),
          size: Number(body.attachment.size) || null,
        }
      : null

  if (!reportKey) return NextResponse.json({ error: "A report is required" }, { status: 400 })
  if (!toEmail) return NextResponse.json({ error: "A recipient email is required" }, { status: 400 })

  const run = await runFinanceReport({
    reportKey,
    from: body.from || "",
    to: body.to || "",
    filters: body.filters && typeof body.filters === "object" ? body.filters : {},
  })
  if (!run.ok || !run.reportMeta) {
    return NextResponse.json({ error: run.error || "Unknown report" }, { status: run.status })
  }

  const company = await getReportCompany()
  const { reportMeta, rows } = run
  const columns = reportMeta.columns

  const moneyCols = columns.filter((c) => c.money)
  const totals: Record<string, number> = {}
  if (moneyCols.length && rows.length) {
    for (const c of moneyCols) totals[c.key] = rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0)
  }
  const hasTotals = moneyCols.length > 0 && rows.length > 0

  const head = columns
    .map(
      (c) =>
        `<th style="padding:8px 10px;border-bottom:2px solid #1f2937;text-align:${
          c.align === "right" || c.money ? "right" : "left"
        };font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#374151;">${esc(
          c.label,
        )}</th>`,
    )
    .join("")

  const bodyRows = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr style="background:${i % 2 ? "#f9fafb" : "#ffffff"};">${columns
              .map(
                (c) =>
                  `<td style="padding:7px 10px;border-bottom:1px solid #eef2f7;text-align:${
                    c.align === "right" || c.money ? "right" : "left"
                  };font-variant-numeric:tabular-nums;color:#111827;">${cell(r[c.key], c)}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("")
    : `<tr><td colspan="${columns.length}" style="padding:16px;text-align:center;color:#6b7280;">No records for the selected period.</td></tr>`

  const footRow = hasTotals
    ? `<tr style="background:#f3f4f6;font-weight:700;">${columns
        .map(
          (c, i) =>
            `<td style="padding:8px 10px;border-top:2px solid #1f2937;text-align:${
              c.align === "right" || c.money ? "right" : "left"
            };font-variant-numeric:tabular-nums;color:#111827;">${
              i === 0 ? "Total" : totals[c.key] !== undefined ? money(totals[c.key]) : ""
            }</td>`,
        )
        .join("")}</tr>`
    : ""

  const addressHtml = company.addressLines.map((l) => esc(l)).join("<br/>")
  const contactBits = [
    company.taxNumber && `${esc(company.taxLabel)}: ${esc(company.taxNumber)}`,
    company.email && `Email: ${esc(company.email)}`,
    company.phone && `Phone: ${esc(company.phone)}`,
  ]
    .filter(Boolean)
    .join(" &nbsp;•&nbsp; ")

  const generatedAt = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })

  // Phase 24/25 — carry the same reconciliation/health verdict the on-screen
  // report shows, so an emailed report is never a silent zero either.
  const diag = run.diagnostics
  const diagBanner =
    diag && diag.level !== "ok"
      ? `<div style="border:1px solid ${
          diag.level === "error" ? "#fca5a5" : "#fcd34d"
        };background:${
          diag.level === "error" ? "#fef2f2" : "#fffbeb"
        };color:${
          diag.level === "error" ? "#b91c1c" : "#92400e"
        };border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px;">
          <strong>${esc(diag.headline)}</strong>${
            diag.checks.filter((c) => c.message !== diag.headline).length
              ? `<ul style="margin:6px 0 0;padding-left:18px;">${diag.checks
                  .filter((c) => c.message !== diag.headline)
                  .map((c) => `<li>${esc(c.message)}</li>`)
                  .join("")}</ul>`
              : ""
        }</div>`
      : ""

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:820px;margin:0 auto;">
    <div style="border-bottom:3px solid #1f2937;padding-bottom:12px;margin-bottom:16px;">
      <div style="font-size:20px;font-weight:700;">${esc(company.name)}</div>
      ${addressHtml ? `<div style="font-size:12px;color:#4b5563;margin-top:2px;">${addressHtml}</div>` : ""}
      ${contactBits ? `<div style="font-size:12px;color:#4b5563;margin-top:4px;">${contactBits}</div>` : ""}
    </div>
    <div style="text-align:center;margin-bottom:14px;">
      <div style="font-size:17px;font-weight:700;">${esc(reportMeta.label)}</div>
      ${subtitle ? `<div style="font-size:12px;color:#4b5563;margin-top:3px;">${esc(subtitle)}</div>` : ""}
      <div style="font-size:11px;color:#6b7280;margin-top:3px;">Generated ${esc(generatedAt)} &nbsp;•&nbsp; ${rows.length} row${rows.length === 1 ? "" : "s"}</div>
    </div>
    ${message ? `<p style="font-size:13px;color:#374151;">${esc(message)}</p>` : ""}
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr>${head}</tr></thead>
      <tbody>${bodyRows}</tbody>
      ${footRow ? `<tfoot>${footRow}</tfoot>` : ""}
    </table>
    <p style="font-size:11px;color:#9ca3af;margin-top:18px;">This report was generated from ${esc(
      company.name,
    )} finance records. Figures reflect posted transactions as of the generated time above.</p>
  </div>`

  // Phase 17: honour the sender's (editable) subject, falling back to the
  // auto-generated "<Report> — <Period • Filters>" default when none is sent.
  const subject = subjectOverride || `${reportMeta.label}${subtitle ? ` — ${subtitle}` : ""}`

  const result = await createFinanceEmail({
    toEmail,
    toName: toName || null,
    cc: body.cc ?? null,
    subject,
    body: html,
    category: "Report",
    sourceModule: "financial-reports",
    sourceRecordId: reportKey,
    emailType: "Manual",
    mode: "send",
    createdBy: (session as any).userId ?? null,
    attachment: attachmentInput,
    render: false,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.code || 400 })
  }

  // Phase 18: record this send in the report run log so it appears in the
  // report Email history alongside downloads (in addition to the Finance
  // Email Hub, which already tracks every finance email).
  await logReportRun({
    reportKey,
    reportLabel: reportMeta.label,
    format: "Email",
    periodLabel: periodLabel || subtitle || null,
    filtersText: filtersText || null,
    recipient: toName ? `${toName} <${toEmail}>` : toEmail,
    status: String(result.status || "Sent"),
    userId: (session as any).userId ?? null,
    userName: session.name || null,
    rowCount: rows.length,
  })

  return NextResponse.json({ ok: true, id: result.id, email_uid: result.emailUid, status: result.status })
}
