import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureNoticeSchema, canView, canManage, resolveEmployee,
  materializeRecipients, dispatchNotice, audit, assignNoticeCode, statusForPublish,
  parseAudienceConfig, type AudienceType, type AudienceConfig,
} from "@/lib/notice-board"

export const dynamic = "force-dynamic"

function baseUrlFrom(request: Request) {
  try { return new URL(request.url).origin } catch { return null }
}

// ---------------------------------------------------------------------------
// GET  /api/notice-board
//   default            -> the signed-in user's own feed (My Notices)
//   ?manage=1          -> management list (requires notice-board.manage)
// ---------------------------------------------------------------------------
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const url = new URL(request.url)
  const manage = url.searchParams.get("manage") === "1"
  const q = (url.searchParams.get("q") || "").trim()
  const from = url.searchParams.get("from") || ""
  const toDate = url.searchParams.get("to_date") || ""
  const category = url.searchParams.get("category") || ""
  const priority = url.searchParams.get("priority") || ""
  const status = url.searchParams.get("status") || ""
  const page = Math.max(1, Number(url.searchParams.get("page") || 1))
  const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get("pageSize") || 20)))
  const offset = (page - 1) * pageSize

  const [categories, departments] = await Promise.all([
    query<{ name: string }[]>("SELECT name FROM notice_categories WHERE active = 1 ORDER BY sort_order, name"),
    query<{ department: string }[]>("SELECT DISTINCT department FROM hr_employees WHERE department IS NOT NULL AND department <> '' ORDER BY department"),
  ])
  const meta = {
    categories: categories.map((c) => c.name),
    departments: departments.map((d) => d.department),
    canManage: await canManage(session),
  }

  if (manage) {
    if (!meta.canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const where: string[] = ["1=1"]
    const params: any[] = []
    if (q) {
      where.push("(n.heading LIKE ? OR n.description LIKE ? OR n.notice_code LIKE ? OR n.category LIKE ? OR n.created_by_name LIKE ?)")
      const like = `%${q}%`
      params.push(like, like, like, like, like)
    }
    if (category) { where.push("n.category = ?"); params.push(category) }
    if (priority) { where.push("n.priority = ?"); params.push(priority) }
    if (status) { where.push("n.status = ?"); params.push(status) }
    if (from) { where.push("DATE(n.created_at) >= ?"); params.push(from) }
    if (toDate) { where.push("DATE(n.created_at) <= ?"); params.push(toDate) }

    const whereSql = where.join(" AND ")
    const [countRow] = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM notices n WHERE ${whereSql}`, params,
    )
    const rows = await query<any[]>(
      `SELECT n.*,
         (SELECT COUNT(*) FROM notice_recipients r WHERE r.notice_id = n.id) AS recipient_count,
         (SELECT COUNT(*) FROM notice_reads rd WHERE rd.notice_id = n.id) AS read_count,
         (SELECT COUNT(*) FROM notice_acknowledgements a WHERE a.notice_id = n.id) AS ack_count
       FROM notices n
       WHERE ${whereSql}
       ORDER BY n.pinned DESC, n.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    )
    const stats = (await query<any[]>(
      `SELECT
         SUM(status='draft') AS drafts,
         SUM(status='scheduled') AS scheduled,
         SUM(status='published') AS published,
         SUM(status='expired') AS expired,
         SUM(status='archived') AS archived,
         SUM(status='cancelled') AS cancelled,
         SUM(status='published' AND priority='urgent') AS urgent
       FROM notices`,
    ))[0]

    return NextResponse.json({
      ...meta,
      notices: rows.map(shapeManage),
      total: countRow?.c ?? 0,
      page, pageSize,
      stats: {
        drafts: Number(stats?.drafts ?? 0),
        scheduled: Number(stats?.scheduled ?? 0),
        published: Number(stats?.published ?? 0),
        expired: Number(stats?.expired ?? 0),
        archived: Number(stats?.archived ?? 0),
        cancelled: Number(stats?.cancelled ?? 0),
        urgent: Number(stats?.urgent ?? 0),
      },
    })
  }

  // ---- Self feed ---------------------------------------------------------
  const emp = await resolveEmployee(session)
  const where: string[] = ["n.to_type = 'employees'", "n.status IN ('published','expired','archived')"]
  const params: any[] = []
  if (emp) {
    where.push(`(
      n.id IN (SELECT notice_id FROM notice_recipients WHERE employee_id = ?)
      OR (n.recipients_finalized = 0 AND (n.department IS NULL OR n.department = '' OR n.department = ?))
    )`)
    params.push(emp.id, emp.department ?? "")
  } else {
    where.push("(n.recipients_finalized = 0 AND (n.department IS NULL OR n.department = ''))")
  }
  if (q) {
    where.push("(n.heading LIKE ? OR n.description LIKE ? OR n.category LIKE ?)")
    const like = `%${q}%`; params.push(like, like, like)
  }
  if (category) { where.push("n.category = ?"); params.push(category) }
  if (priority) { where.push("n.priority = ?"); params.push(priority) }
  if (from) { where.push("DATE(COALESCE(n.published_at, n.created_at)) >= ?"); params.push(from) }
  if (toDate) { where.push("DATE(COALESCE(n.published_at, n.created_at)) <= ?"); params.push(toDate) }

  const empId = emp?.id ?? 0
  const rows = await query<any[]>(
    `SELECT n.*,
       (rd.id IS NOT NULL) AS is_read,
       (ack.id IS NOT NULL) AS is_acknowledged
     FROM notices n
     LEFT JOIN notice_reads rd ON rd.notice_id = n.id AND rd.employee_id = ?
     LEFT JOIN notice_acknowledgements ack ON ack.notice_id = n.id AND ack.employee_id = ?
     WHERE ${where.join(" AND ")}
     ORDER BY n.pinned DESC,
       FIELD(n.priority,'urgent','important','normal'),
       COALESCE(n.published_at, n.created_at) DESC
     LIMIT ? OFFSET ?`,
    [empId, empId, ...params, pageSize, offset],
  )

  const feed = rows.map(shapeFeed)
  const counts = {
    active: feed.filter((n) => n.status === "published").length,
    unread: feed.filter((n) => n.status === "published" && !n.is_read).length,
    important: feed.filter((n) => n.status === "published" && n.priority === "important").length,
    urgent: feed.filter((n) => n.status === "published" && n.priority === "urgent").length,
    ackPending: feed.filter((n) => n.status === "published" && n.acknowledgement_required && !n.is_acknowledged).length,
  }
  return NextResponse.json({ ...meta, notices: feed, counts, hasEmployeeRecord: !!emp })
}

function shapeManage(n: any) {
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
    department: n.department,
    acknowledgement_required: !!n.acknowledgement_required,
    notify_in_app: !!n.notify_in_app,
    notify_email: !!n.notify_email,
    pinned: !!n.pinned,
    start_date: n.start_date,
    end_date: n.end_date,
    publish_date: n.publish_date,
    published_at: n.published_at,
    effective_date: n.effective_date,
    review_date: n.review_date,
    version: n.version,
    created_by_name: n.created_by_name,
    created_at: n.created_at,
    recipient_count: Number(n.recipient_count ?? 0),
    read_count: Number(n.read_count ?? 0),
    ack_count: Number(n.ack_count ?? 0),
  }
}

function shapeFeed(n: any) {
  return {
    id: n.id,
    notice_code: n.notice_code,
    heading: n.heading,
    description: n.description,
    category: n.category,
    priority: n.priority,
    status: n.status,
    pinned: !!n.pinned,
    acknowledgement_required: !!n.acknowledgement_required,
    is_read: !!n.is_read,
    is_acknowledged: !!n.is_acknowledged,
    published_at: n.published_at,
    end_date: n.end_date,
    created_by_name: n.created_by_name,
    created_at: n.created_at,
  }
}

// ---------------------------------------------------------------------------
// POST /api/notice-board   (create draft or publish)
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

  const action: "draft" | "publish" = body.action === "publish" ? "publish" : "draft"
  const heading = String(body.heading ?? "").trim()
  const description = String(body.description ?? "").trim()
  if (!heading) return NextResponse.json({ error: "Notice heading is required" }, { status: 400 })
  if (action === "publish" && !description)
    return NextResponse.json({ error: "Notice details are required to publish" }, { status: 400 })

  const to_type: "employees" | "clients" = body.to_type === "clients" ? "clients" : "employees"
  const audience_type: AudienceType = to_type === "clients" ? "all" : (body.audience_type ?? "all")
  const audience_config: AudienceConfig = body.audience_config ?? {}
  const validated = validateAudience(to_type, audience_type, audience_config)
  if (action === "publish" && validated.error)
    return NextResponse.json({ error: validated.error }, { status: 400 })

  const startDate = body.start_date || null
  const endDate = body.end_date || null
  if (startDate && endDate && endDate < startDate)
    return NextResponse.json({ error: "End date must be on or after start date" }, { status: 400 })

  const publishDate = body.publish_date || null
  const status = action === "publish" ? statusForPublish(publishDate, endDate) : "draft"
  const legacyDept = audience_type === "department" && audience_config.departments?.length === 1
    ? audience_config.departments[0] : null

  const res: any = await query(
    `INSERT INTO notices
      (heading, description, category, priority, status, to_type, audience_type, audience_config, include_inactive,
       department, start_date, end_date, publish_date, published_at, acknowledgement_required, notify_in_app, notify_email,
       pinned, keep_pinned_after_expiry, effective_date, review_date, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      heading, description,
      String(body.category || "General"),
      normalizePriority(body.priority),
      status, to_type, audience_type, JSON.stringify(audience_config), body.include_inactive ? 1 : 0,
      legacyDept,
      startDate, endDate, publishDate,
      status === "published" ? new Date() : null,
      body.acknowledgement_required ? 1 : 0,
      body.notify_in_app === false ? 0 : 1,
      body.notify_email ? 1 : 0,
      body.pinned ? 1 : 0,
      body.keep_pinned_after_expiry ? 1 : 0,
      body.effective_date || null, body.review_date || null,
      session.userId, session.name,
    ],
  )
  const id = res.insertId as number
  await assignNoticeCode(id)

  // Attach any pre-uploaded draft attachments.
  if (Array.isArray(body.attachment_ids) && body.attachment_ids.length) {
    await query(
      `UPDATE notice_attachments SET notice_id = ?, draft_key = NULL
       WHERE id IN (${body.attachment_ids.map(() => "?").join(",")}) AND uploaded_by = ? AND notice_id IS NULL`,
      [id, ...body.attachment_ids.map((x: any) => Number(x)), session.userId],
    )
  }

  await audit(id, session, action === "publish" ? "created_published" : "created_draft", `Status: ${status}`)

  if (status === "published" || status === "scheduled") {
    const notice = (await query<any[]>("SELECT * FROM notices WHERE id = ?", [id]))[0]
    await materializeRecipients(id, notice)
    if (status === "published") await dispatchNotice(id, baseUrlFrom(request))
  }

  return NextResponse.json({ id, status }, { status: 201 })
}

function normalizePriority(p: any) {
  return ["normal", "important", "urgent"].includes(p) ? p : "normal"
}

function validateAudience(toType: string, type: AudienceType, cfg: AudienceConfig): { error?: string } {
  if (toType === "clients") return {}
  if (type === "all") return {}
  const map: Record<string, keyof AudienceConfig> = {
    department: "departments", designation: "designations", location: "locations",
    employment_type: "employmentTypes", employees: "employeeIds",
  }
  const key = map[type]
  const arr = key ? (cfg as any)[key] : null
  if (!Array.isArray(arr) || arr.length === 0)
    return { error: "Please select at least one target for the chosen audience type" }
  return {}
}
