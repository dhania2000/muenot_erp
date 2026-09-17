import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureNoticeSchema, canView, canManage, resolveEmployee, employeeCanSee,
  materializeRecipients, snapshotVersion, audit, parseAudienceConfig, normalizeAudienceValidated,
  type AudienceType, type AudienceConfig,
} from "@/lib/notice-board"

export const dynamic = "force-dynamic"

async function loadNotice(id: number) {
  return (await query<any[]>("SELECT * FROM notices WHERE id = ? LIMIT 1", [id]))[0] ?? null
}

async function attachmentsFor(id: number) {
  return query<any[]>(
    "SELECT id, file_name, file_type, file_size, created_at FROM notice_attachments WHERE notice_id = ? ORDER BY id",
    [id],
  )
}

// GET /api/notice-board/[id] — full detail
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = await loadNotice(id)
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const manage = await canManage(session)
  const emp = await resolveEmployee(session)

  if (!manage) {
    if (!(await employeeCanSee(id, emp)))
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const attachments = await attachmentsFor(id)
  const base: any = {
    ...shape(notice),
    attachments,
  }

  if (manage) {
    const [auditTrail, versions] = await Promise.all([
      query<any[]>("SELECT action, detail, user_name, created_at FROM notice_audit WHERE notice_id = ? ORDER BY id DESC LIMIT 100", [id]),
      query<any[]>("SELECT version, heading, edited_by_name, edited_at FROM notice_versions WHERE notice_id = ? ORDER BY version DESC", [id]),
    ])
    base.audit = auditTrail
    base.versions = versions
  } else if (emp) {
    const [[rd], [ack]] = await Promise.all([
      query<any[]>("SELECT id FROM notice_reads WHERE notice_id = ? AND employee_id = ?", [id, emp.id]),
      query<any[]>("SELECT id FROM notice_acknowledgements WHERE notice_id = ? AND employee_id = ?", [id, emp.id]),
    ])
    base.is_read = !!rd
    base.is_acknowledged = !!ack
  }

  return NextResponse.json({ notice: base, canManage: manage })
}

// PATCH /api/notice-board/[id] — edit fields (manager only)
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = await loadNotice(id)
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (["cancelled"].includes(notice.status))
    return NextResponse.json({ error: "Cancelled notices cannot be edited" }, { status: 409 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

  const heading = body.heading !== undefined ? String(body.heading).trim() : notice.heading
  if (!heading) return NextResponse.json({ error: "Notice heading is required" }, { status: 400 })
  const description = body.description !== undefined ? String(body.description).trim() : notice.description

  const to_type = body.to_type === "clients" ? "clients" : body.to_type === "employees" ? "employees" : notice.to_type
  const audience_type: AudienceType = to_type === "clients" ? "all" : (body.audience_type ?? notice.audience_type)
  const audience_config: AudienceConfig = body.audience_config ?? parseAudienceConfig(notice.audience_config)

  const audErr = normalizeAudienceValidated(to_type, audience_type, audience_config)
  if (audErr) return NextResponse.json({ error: audErr }, { status: 400 })

  const startDate = body.start_date !== undefined ? (body.start_date || null) : notice.start_date
  const endDate = body.end_date !== undefined ? (body.end_date || null) : notice.end_date

  // Snapshot the current content before overwriting, then bump the version.
  await snapshotVersion(notice, session)
  const newVersion = (notice.version ?? 1) + 1
  const legacyDept = audience_type === "department" && audience_config.departments?.length === 1
    ? audience_config.departments[0] : null

  await query(
    `UPDATE notices SET
       heading = ?, description = ?, category = ?, priority = ?,
       to_type = ?, audience_type = ?, audience_config = ?, include_inactive = ?, department = ?,
       start_date = ?, end_date = ?, publish_date = ?,
       acknowledgement_required = ?, notify_in_app = ?, notify_email = ?,
       pinned = ?, keep_pinned_after_expiry = ?, effective_date = ?, review_date = ?,
       version = ?, updated_by = ?, updated_by_name = ?
     WHERE id = ?`,
    [
      heading, description,
      body.category !== undefined ? String(body.category || "General") : notice.category,
      body.priority !== undefined ? normalizePriority(body.priority) : notice.priority,
      to_type, audience_type, JSON.stringify(audience_config),
      body.include_inactive !== undefined ? (body.include_inactive ? 1 : 0) : notice.include_inactive,
      legacyDept,
      startDate, endDate,
      body.publish_date !== undefined ? (body.publish_date || null) : notice.publish_date,
      body.acknowledgement_required !== undefined ? (body.acknowledgement_required ? 1 : 0) : notice.acknowledgement_required,
      body.notify_in_app !== undefined ? (body.notify_in_app ? 1 : 0) : notice.notify_in_app,
      body.notify_email !== undefined ? (body.notify_email ? 1 : 0) : notice.notify_email,
      body.pinned !== undefined ? (body.pinned ? 1 : 0) : notice.pinned,
      body.keep_pinned_after_expiry !== undefined ? (body.keep_pinned_after_expiry ? 1 : 0) : notice.keep_pinned_after_expiry,
      body.effective_date !== undefined ? (body.effective_date || null) : notice.effective_date,
      body.review_date !== undefined ? (body.review_date || null) : notice.review_date,
      newVersion, session.userId, session.name, id,
    ],
  )

  if (Array.isArray(body.attachment_ids) && body.attachment_ids.length) {
    await query(
      `UPDATE notice_attachments SET notice_id = ?, draft_key = NULL
       WHERE id IN (${body.attachment_ids.map(() => "?").join(",")}) AND uploaded_by = ? AND notice_id IS NULL`,
      [id, ...body.attachment_ids.map((x: any) => Number(x)), session.userId],
    )
  }

  // If already published/scheduled, refresh the recipient set (adds new matches).
  if (["published", "scheduled"].includes(notice.status)) {
    const refreshed = await loadNotice(id)
    await materializeRecipients(id, refreshed)
  }

  await audit(id, session, "edited", `v${newVersion}`)
  return NextResponse.json({ id, version: newVersion })
}

// DELETE /api/notice-board/[id]
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = await loadNotice(id)
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (notice.status === "draft") {
    await query("DELETE FROM notices WHERE id = ?", [id])
    await audit(null, session, "deleted_draft", `Notice ${notice.notice_code || id}`)
    return NextResponse.json({ deleted: true })
  }
  // Non-drafts are archived (soft) to preserve the audit trail.
  await query("UPDATE notices SET status = 'archived' WHERE id = ?", [id])
  await audit(id, session, "archived", "Archived via delete")
  return NextResponse.json({ archived: true })
}

function normalizePriority(p: any) {
  return ["normal", "important", "urgent"].includes(p) ? p : "normal"
}

function shape(n: any) {
  return {
    id: n.id,
    notice_code: n.notice_code,
    heading: n.heading,
    description: n.description,
    category: n.category,
    priority: n.priority,
    status: n.status,
    to_type: n.to_type,
    audience_type: n.audience_type,
    audience_config: parseAudienceConfig(n.audience_config),
    include_inactive: !!n.include_inactive,
    department: n.department,
    acknowledgement_required: !!n.acknowledgement_required,
    notify_in_app: !!n.notify_in_app,
    notify_email: !!n.notify_email,
    pinned: !!n.pinned,
    keep_pinned_after_expiry: !!n.keep_pinned_after_expiry,
    start_date: n.start_date,
    end_date: n.end_date,
    publish_date: n.publish_date,
    published_at: n.published_at,
    expired_at: n.expired_at,
    effective_date: n.effective_date,
    review_date: n.review_date,
    cancel_reason: n.cancel_reason,
    version: n.version,
    created_by_name: n.created_by_name,
    created_at: n.created_at,
    updated_by_name: n.updated_by_name,
  }
}
