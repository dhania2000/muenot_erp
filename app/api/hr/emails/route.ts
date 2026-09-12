import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { isEmailConfigured } from "@/lib/email"
import {
  createHrEmail,
  ensureHrEmailHubSchema,
  parseAddressList,
  SENSITIVE_HR_EMAIL_CATEGORIES,
} from "@/lib/hr-email"

const STATUSES = new Set([
  "Draft",
  "Scheduled",
  "Queued",
  "Sending",
  "Sent",
  "Failed",
  "Cancelled",
])

export async function GET(request: NextRequest) {
  const session = await requireFeature("hr.view_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureHrEmailHubSchema()

  const sp = request.nextUrl.searchParams
  const where: string[] = []
  const args: any[] = []

  const q = (sp.get("q") || "").trim()
  if (q) {
    const like = `%${q}%`
    where.push(
      "(email_uid LIKE ? OR to_email LIKE ? OR to_name LIKE ? OR subject LIKE ? OR category LIKE ?)",
    )
    args.push(like, like, like, like, like)
  }
  const status = sp.get("status") || ""
  if (status && STATUSES.has(status)) {
    where.push("status = ?")
    args.push(status)
  }
  const category = sp.get("category") || ""
  if (category) {
    where.push("category = ?")
    args.push(category)
  }
  const sourceModule = sp.get("source_module") || ""
  if (sourceModule) {
    where.push("source_module = ?")
    args.push(sourceModule)
  }
  const employeeId = sp.get("employee_id")
  if (employeeId) {
    where.push("employee_id = ?")
    args.push(Number(employeeId))
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const page = Math.max(1, Number(sp.get("page") || 1))
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize") || 25)))
  const offset = (page - 1) * pageSize

  const [rows, totalRows, summaryRows] = await Promise.all([
    query<any[]>(
      `SELECT id, email_uid, employee_id, to_email, to_name, cc, bcc, template_id, subject,
              category, source_module, source_record_id, email_type, status, scheduled_at,
              open_count, opened_at, attempts, last_error, attachment_name, sent_at, created_by
       FROM hr_emails ${clause}
       ORDER BY COALESCE(scheduled_at, sent_at) DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    ),
    query<any[]>(`SELECT COUNT(*) AS total FROM hr_emails ${clause}`, args),
    query<any[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(status='Sent') AS sent,
         SUM(status='Failed') AS failed,
         SUM(status IN ('Scheduled','Queued')) AS pending,
         SUM(status='Draft') AS drafts,
         SUM(open_count > 0) AS opened
       FROM hr_emails`,
    ),
  ])

  const s = summaryRows[0] || {}
  return NextResponse.json({
    emails: rows,
    total: Number(totalRows[0]?.total || 0),
    page,
    pageSize,
    configured: isEmailConfigured("hr"),
    summary: {
      total: Number(s.total || 0),
      sent: Number(s.sent || 0),
      failed: Number(s.failed || 0),
      pending: Number(s.pending || 0),
      drafts: Number(s.drafts || 0),
      opened: Number(s.opened || 0),
    },
  })
}

export async function POST(request: NextRequest) {
  // Base gate: composing/sending requires write access to HR Emails.
  const session = await requireFeature("hr.send_email")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const mode: "send" | "draft" | "schedule" =
    body.mode === "draft" || body.mode === "schedule" ? body.mode : "send"

  const category = (body.category || "General").trim() || "General"

  // Sensitive categories need the extra permission.
  if (SENSITIVE_HR_EMAIL_CATEGORIES.has(category)) {
    const ok = await requireFeature("hr.send_sensitive_email")
    if (!ok) {
      return NextResponse.json(
        { error: "You do not have permission to send confidential/warning emails" },
        { status: 403 },
      )
    }
  }

  // Scheduling needs its own permission.
  if (mode === "schedule") {
    const ok = await requireFeature("hr.schedule_email")
    if (!ok) {
      return NextResponse.json(
        { error: "You do not have permission to schedule emails" },
        { status: 403 },
      )
    }
  }

  // Bulk send (multiple recipients) needs the bulk permission.
  const employeeIds: number[] = Array.isArray(body.employee_ids)
    ? body.employee_ids.map((n: any) => Number(n)).filter(Boolean)
    : []
  const isBulk = employeeIds.length > 1
  if (isBulk) {
    const ok = await requireFeature("hr.send_bulk_email")
    if (!ok) {
      return NextResponse.json(
        { error: "You do not have permission to send bulk emails" },
        { status: 403 },
      )
    }
  }

  const shared = {
    cc: body.cc ?? null,
    bcc: body.bcc ?? null,
    subject: body.subject,
    body: body.body,
    templateId: body.template_id ?? null,
    category,
    sourceModule: "manual",
    emailType: "Manual" as const,
    scheduledAt: body.scheduled_at ?? null,
    mode,
    createdBy: session.userId,
    attachment: body.attachment ?? null,
  }

  // Bulk: create one record per selected employee, rendering per recipient.
  if (employeeIds.length) {
    const results = []
    for (const employeeId of employeeIds) {
      results.push(await createHrEmail({ ...shared, employeeId, render: true }))
    }
    const failures = results.filter((r) => !r.ok)
    return NextResponse.json({
      ok: failures.length === 0,
      created: results.filter((r) => r.ok).length,
      failed: failures.length,
      errors: failures.map((r) => (r.ok ? null : r.error)).filter(Boolean),
    })
  }

  // Single: manual address or single employee.
  const toList = parseAddressList(body.to_email)
  const result = await createHrEmail({
    ...shared,
    employeeId: body.employee_id ? Number(body.employee_id) : null,
    toEmail: toList[0] ?? body.to_email ?? null,
    toName: body.to_name ?? null,
    render: Boolean(body.employee_id),
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.code || 400 })
  }
  return NextResponse.json({
    ok: true,
    id: result.id,
    email_uid: result.emailUid,
    status: result.status,
  })
}
