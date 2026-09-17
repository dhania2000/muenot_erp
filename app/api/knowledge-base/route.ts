import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureKbSchema, canView, canManage, resolveEmployee,
  sanitizeContent, toPlainText, parseTags, syncTags, syncRelated, syncErpLinks,
  parseAudienceConfig, normalizeAudienceValidated, materializeRecipients, dispatchArticle,
  statusForPublish, assignArticleCode, audit, snapshotVersion, labelForType,
  CONTENT_TYPES, AUDIENCE_TYPES, TO_TYPES, type ContentType, type AudienceType, type ToType,
} from "@/lib/knowledge-base"

export const dynamic = "force-dynamic"

const SORTS: Record<string, string> = {
  newest: "a.created_at DESC",
  updated: "a.updated_at DESC",
  most_viewed: "a.view_count DESC",
  most_helpful: "a.helpful_count DESC",
  az: "a.heading ASC",
}

// ---------------------------------------------------------------------------
// GET — list with search, advanced filters, sorting, pagination.
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const manage = await canManage(session)
  const emp = manage ? null : await resolveEmployee(session)
  const sp = request.nextUrl.searchParams

  const where: string[] = ["1=1"]
  const params: unknown[] = []

  if (!manage) {
    // Server-side visibility: employees only see content targeted to them.
    where.push("a.to_type = 'employees'")
    where.push("a.status IN ('published','expired','archived')")
    if (emp) {
      where.push(`(a.id IN (SELECT article_id FROM kb_recipients WHERE employee_id = ?)
                   OR (a.recipients_finalized = 0 AND a.audience_type = 'all'))`)
      params.push(emp.id)
    } else {
      where.push("(a.recipients_finalized = 0 AND a.audience_type = 'all')")
    }
  } else if (sp.get("to") && sp.get("to") !== "all") {
    where.push("a.to_type = ?")
    params.push(sp.get("to"))
  }

  const section = sp.get("section")
  if (section && CONTENT_TYPES.includes(section as ContentType)) {
    where.push("a.content_type = ?")
    params.push(section)
  }
  const contentType = sp.get("content_type")
  if (contentType && contentType !== "all" && CONTENT_TYPES.includes(contentType as ContentType)) {
    where.push("a.content_type = ?")
    params.push(contentType)
  }

  const category = sp.get("category")
  if (category && category !== "all") { where.push("a.category_id = ?"); params.push(Number(category)) }

  const status = sp.get("status")
  if (manage && status && status !== "all") { where.push("a.status = ?"); params.push(status) }

  const author = sp.get("author")
  if (author && author !== "all") { where.push("a.author_id = ?"); params.push(Number(author)) }

  const department = sp.get("department")
  if (department && department !== "all") { where.push("a.department = ?"); params.push(department) }

  const tag = sp.get("tag")
  if (tag) { where.push("a.id IN (SELECT article_id FROM kb_tags WHERE tag = ?)"); params.push(tag) }

  if (sp.get("pinned") === "1") where.push("a.pinned = 1")
  if (sp.get("important") === "1") where.push("a.important = 1")

  if (sp.get("favorites") === "1" && emp) {
    where.push("a.id IN (SELECT article_id FROM kb_favorites WHERE employee_id = ?)")
    params.push(emp.id)
  }

  const from = sp.get("from")
  if (from) { where.push("DATE(a.created_at) >= ?"); params.push(from) }
  const to = sp.get("to_date")
  if (to) { where.push("DATE(a.created_at) <= ?"); params.push(to) }

  const q = sp.get("q")?.trim()
  if (q) {
    where.push(`(a.heading LIKE ? OR a.summary LIKE ? OR a.content LIKE ? OR a.article_code LIKE ?
                 OR a.subcategory LIKE ? OR a.tags LIKE ? OR a.author_name LIKE ? OR a.department LIKE ?
                 OR c.name LIKE ?)`)
    const like = `%${q}%`
    params.push(like, like, like, like, like, like, like, like, like)
  }

  const sort = SORTS[sp.get("sort") || "newest"] || SORTS.newest
  const page = Math.max(1, Number(sp.get("page") || 1))
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize") || 30)))
  const offset = (page - 1) * pageSize

  const whereSql = where.join(" AND ")
  const [countRow] = await query<any[]>(
    `SELECT COUNT(*) AS c FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id WHERE ${whereSql}`,
    params,
  )
  const total = countRow?.c ?? 0

  // Do NOT select full content for list rows (Phase 96 — keep list light).
  // Exact title/tag matches rank first (Phase 58).
  const rankParams: unknown[] = []
  let rankSql = "0"
  if (q) {
    rankSql = `(CASE WHEN a.heading = ? THEN 100 ELSE 0 END
               + CASE WHEN a.heading LIKE ? THEN 40 ELSE 0 END
               + CASE WHEN a.id IN (SELECT article_id FROM kb_tags WHERE tag = ?) THEN 30 ELSE 0 END)`
    rankParams.push(q, `${q}%`, q)
  }

  const articles = await query<any[]>(
    `SELECT a.id, a.article_code, a.heading, a.summary, a.category_id, a.subcategory, a.tags,
            a.content_type, a.to_type, a.status, a.version, a.audience_type, a.department,
            a.author_id, a.author_name, a.owner_id, a.owner_name,
            a.pinned, a.important, a.acknowledgement_required, a.view_count, a.helpful_count, a.not_helpful_count,
            a.publish_date, a.published_at, a.review_date, a.expiry_date, a.effective_date,
            a.created_at, a.updated_at,
            c.name AS category_name,
            ${rankSql} AS rank_score,
            ${emp ? "(SELECT COUNT(*) FROM kb_favorites f WHERE f.article_id = a.id AND f.employee_id = ?)" : "0"} AS is_favorite,
            ${emp ? "(SELECT COUNT(*) FROM kb_reads r WHERE r.article_id = a.id AND r.employee_id = ?)" : "0"} AS is_read,
            ${emp ? "(SELECT COUNT(*) FROM kb_acknowledgements k WHERE k.article_id = a.id AND k.employee_id = ?)" : "0"} AS is_acknowledged,
            (SELECT COUNT(*) FROM kb_attachments att WHERE att.article_id = a.id) AS attachment_count
     FROM kb_articles a
     LEFT JOIN kb_categories c ON c.id = a.category_id
     WHERE ${whereSql}
     ORDER BY a.pinned DESC, ${q ? "rank_score DESC," : ""} ${sort}
     LIMIT ? OFFSET ?`,
    [...rankParams, ...params, ...(emp ? [emp.id, emp.id, emp.id] : []), pageSize, offset],
  )

  const categories = await query<any[]>("SELECT id, name FROM kb_categories WHERE active = 1 ORDER BY sort_order, name")

  return NextResponse.json({
    articles,
    categories,
    total,
    page,
    pageSize,
    canManage: manage,
    contentTypes: CONTENT_TYPES.map((t) => ({ value: t, label: labelForType(t) })),
  })
}

// ---------------------------------------------------------------------------
// Shared write helpers
// ---------------------------------------------------------------------------
async function requireManage() {
  const session = await getSession()
  if (!session) return null
  if (!(await canManage(session))) return null
  return session
}

async function resolveCategory(body: any): Promise<number | null> {
  if (body.new_category && String(body.new_category).trim()) {
    const name = String(body.new_category).trim().slice(0, 150)
    await query("INSERT IGNORE INTO kb_categories (name) VALUES (?)", [name])
    const rows = await query<any[]>("SELECT id FROM kb_categories WHERE name = ? LIMIT 1", [name])
    return rows[0]?.id ?? null
  }
  return body.category_id ? Number(body.category_id) : null
}

function normalizeStatusFromAction(action: string, publishDate: string | null, expiryDate: string | null) {
  if (action === "publish") return statusForPublish(publishDate, expiryDate)
  if (action === "submit") return "in_review"
  return "draft"
}

// ---------------------------------------------------------------------------
// POST — create an article (draft, submit for review, or publish).
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const body = await request.json()
  const heading = String(body.heading || "").trim()
  const rawContent = String(body.content ?? body.description ?? "")
  const content = sanitizeContent(rawContent)
  const summary = String(body.summary || "").trim().slice(0, 600) || toPlainText(content, 200)

  if (!heading) return NextResponse.json({ error: "Title is required" }, { status: 400 })
  if (heading.length > 200) return NextResponse.json({ error: "Title is too long" }, { status: 400 })
  if (!toPlainText(content)) return NextResponse.json({ error: "Content is required" }, { status: 400 })

  const contentType: ContentType = CONTENT_TYPES.includes(body.content_type) ? body.content_type : "article"
  const toType: ToType = TO_TYPES.includes(body.to_type) ? body.to_type : "employees"
  const audienceType: AudienceType = AUDIENCE_TYPES.includes(body.audience_type) ? body.audience_type : "all"
  const audienceConfig = parseAudienceConfig(body.audience_config)
  const categoryId = await resolveCategory(body)

  const action = String(body.action || "draft") // draft | submit | publish
  if (action === "publish" || action === "submit") {
    const audErr = toType === "clients" ? null : normalizeAudienceValidated(audienceType, audienceConfig)
    if (audErr) return NextResponse.json({ error: audErr }, { status: 400 })
  }
  const status = normalizeStatusFromAction(action, body.publish_date || null, body.expiry_date || null)

  const ownerId = body.owner_id ? Number(body.owner_id) : null
  const ownerName = body.owner_name ? String(body.owner_name).slice(0, 150) : session.name

  const res: any = await query(
    `INSERT INTO kb_articles
       (heading, description, summary, content, category_id, subcategory, content_type, to_type,
        audience_type, audience_config, department, status, version,
        author_id, author_name, owner_id, owner_name,
        publish_date, published_at, effective_date, review_date, expiry_date,
        acknowledgement_required, notify_in_app, notify_email, pinned, keep_pinned_after_expiry, important,
        source_module, source_record_id, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      heading, summary, summary, content, categoryId, body.subcategory ? String(body.subcategory).slice(0, 120) : null,
      contentType, toType, audienceType, JSON.stringify(audienceConfig),
      body.department ? String(body.department).slice(0, 150) : null,
      status, session.userId, session.name, ownerId, ownerName,
      body.publish_date || null, status === "published" ? new Date() : null,
      body.effective_date || null, body.review_date || null, body.expiry_date || null,
      body.acknowledgement_required ? 1 : 0, body.notify_in_app === false ? 0 : 1, body.notify_email ? 1 : 0,
      body.pinned ? 1 : 0, body.keep_pinned_after_expiry ? 1 : 0, body.important ? 1 : 0,
      body.source_module ? String(body.source_module).slice(0, 60) : null,
      body.source_record_id ? String(body.source_record_id).slice(0, 80) : null,
      session.userId, session.name,
    ],
  )
  const id = res.insertId
  await assignArticleCode(id)
  await syncTags(id, parseTags(body.tags))
  if (Array.isArray(body.related_ids)) await syncRelated(id, body.related_ids.map((n: any) => Number(n)).filter(Boolean))
  if (Array.isArray(body.erp_links)) await syncErpLinks(id, body.erp_links)

  // Link any draft attachments to this article.
  if (body.draft_key) {
    await query("UPDATE kb_attachments SET article_id = ? WHERE draft_key = ? AND article_id IS NULL", [id, String(body.draft_key).slice(0, 64)])
  }

  const article = (await query<any[]>("SELECT * FROM kb_articles WHERE id = ?", [id]))[0]
  await snapshotVersion(article, session, "Created")
  await audit(id, session, "created", `${labelForType(contentType)} created as ${status}`)

  let dispatch = null
  if (status === "published") {
    await materializeRecipients(id, article)
    dispatch = await dispatchArticle(id, new URL(request.url).origin)
    await audit(id, session, "published", "Published on create")
  } else if (status === "scheduled") {
    await materializeRecipients(id, article)
  }

  return NextResponse.json({ ok: true, id, status, dispatch }, { status: 201 })
}

// ---------------------------------------------------------------------------
// PATCH — update an article. Optimistic locking via `version` (Phase 80).
// ---------------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const body = await request.json()
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: "Article id required" }, { status: 400 })

  const current = (await query<any[]>("SELECT * FROM kb_articles WHERE id = ? LIMIT 1", [id]))[0]
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Optimistic concurrency: reject stale writes.
  if (body.expected_version != null && Number(body.expected_version) !== Number(current.version)) {
    return NextResponse.json({
      error: "This article was updated by someone else. Reload to get the latest version.",
      code: "version_conflict",
      currentVersion: current.version,
    }, { status: 409 })
  }

  const heading = String(body.heading || "").trim()
  const content = sanitizeContent(String(body.content ?? body.description ?? ""))
  const summary = String(body.summary || "").trim().slice(0, 600) || toPlainText(content, 200)
  if (!heading) return NextResponse.json({ error: "Title is required" }, { status: 400 })
  if (!toPlainText(content)) return NextResponse.json({ error: "Content is required" }, { status: 400 })

  const contentType: ContentType = CONTENT_TYPES.includes(body.content_type) ? body.content_type : current.content_type
  const toType: ToType = TO_TYPES.includes(body.to_type) ? body.to_type : current.to_type
  const audienceType: AudienceType = AUDIENCE_TYPES.includes(body.audience_type) ? body.audience_type : current.audience_type
  const audienceConfig = parseAudienceConfig(body.audience_config ?? current.audience_config)
  const categoryId = body.new_category || body.category_id !== undefined ? await resolveCategory(body) : current.category_id

  // Snapshot the pre-edit state, then bump version.
  await snapshotVersion(current, session, body.change_summary || "Edited")
  const nextVersion = Number(current.version) + 1

  const audienceChanged =
    audienceType !== current.audience_type ||
    JSON.stringify(audienceConfig) !== JSON.stringify(parseAudienceConfig(current.audience_config)) ||
    toType !== current.to_type

  await query(
    `UPDATE kb_articles SET
       heading = ?, description = ?, summary = ?, content = ?, category_id = ?, subcategory = ?,
       content_type = ?, to_type = ?, audience_type = ?, audience_config = ?, department = ?,
       owner_id = ?, owner_name = ?, publish_date = ?, effective_date = ?, review_date = ?, expiry_date = ?,
       acknowledgement_required = ?, notify_in_app = ?, notify_email = ?, pinned = ?, keep_pinned_after_expiry = ?, important = ?,
       source_module = ?, source_record_id = ?, version = ?, updated_by = ?, updated_by_name = ?,
       recipients_finalized = ?
     WHERE id = ?`,
    [
      heading, summary, summary, content, categoryId, body.subcategory ? String(body.subcategory).slice(0, 120) : current.subcategory,
      contentType, toType, audienceType, JSON.stringify(audienceConfig),
      body.department !== undefined ? (body.department ? String(body.department).slice(0, 150) : null) : current.department,
      body.owner_id !== undefined ? (body.owner_id ? Number(body.owner_id) : null) : current.owner_id,
      body.owner_name !== undefined ? (body.owner_name ? String(body.owner_name).slice(0, 150) : null) : current.owner_name,
      body.publish_date !== undefined ? (body.publish_date || null) : current.publish_date,
      body.effective_date !== undefined ? (body.effective_date || null) : current.effective_date,
      body.review_date !== undefined ? (body.review_date || null) : current.review_date,
      body.expiry_date !== undefined ? (body.expiry_date || null) : current.expiry_date,
      body.acknowledgement_required ? 1 : 0, body.notify_in_app === false ? 0 : 1, body.notify_email ? 1 : 0,
      body.pinned ? 1 : 0, body.keep_pinned_after_expiry ? 1 : 0, body.important ? 1 : 0,
      body.source_module !== undefined ? (body.source_module ? String(body.source_module).slice(0, 60) : null) : current.source_module,
      body.source_record_id !== undefined ? (body.source_record_id ? String(body.source_record_id).slice(0, 80) : null) : current.source_record_id,
      nextVersion, session.userId, session.name,
      audienceChanged ? 0 : current.recipients_finalized,
      id,
    ],
  )

  if (body.tags !== undefined) await syncTags(id, parseTags(body.tags))
  if (Array.isArray(body.related_ids)) await syncRelated(id, body.related_ids.map((n: any) => Number(n)).filter(Boolean))
  if (Array.isArray(body.erp_links)) await syncErpLinks(id, body.erp_links)
  if (body.draft_key) {
    await query("UPDATE kb_attachments SET article_id = ? WHERE draft_key = ? AND article_id IS NULL", [id, String(body.draft_key).slice(0, 64)])
  }

  // If audience changed on a live article, re-materialize recipients + notify new ones.
  const refreshed = (await query<any[]>("SELECT * FROM kb_articles WHERE id = ?", [id]))[0]
  if (audienceChanged && refreshed.status === "published") {
    await materializeRecipients(id, refreshed)
    await dispatchArticle(id, new URL(request.url).origin)
  }

  await audit(id, session, "edited", `Version ${nextVersion}${body.change_summary ? `: ${body.change_summary}` : ""}`)
  return NextResponse.json({ ok: true, id, version: nextVersion })
}

// ---------------------------------------------------------------------------
// DELETE — guarded hard delete (Phase 95). Policy/compliance content requires
// admin. Everything is audited first.
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const id = Number(request.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Article id required" }, { status: 400 })

  const article = (await query<any[]>("SELECT * FROM kb_articles WHERE id = ? LIMIT 1", [id]))[0]
  if (!article) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const protectedType = ["policy", "sop"].includes(article.content_type) || article.acknowledgement_required
  if (protectedType && session.role !== "admin") {
    return NextResponse.json({
      error: "Policy, SOP and acknowledgement-required content can only be deleted by an administrator. Consider archiving instead.",
    }, { status: 403 })
  }

  await audit(id, session, "deleted", `${labelForType(article.content_type)} "${article.heading}" deleted`)
  // Companion rows are removed to avoid orphans; audit row is kept for the trail.
  for (const t of ["kb_tags", "kb_recipients", "kb_reads", "kb_acknowledgements", "kb_attachments",
    "kb_versions", "kb_deliveries", "kb_reminders", "kb_feedback", "kb_favorites", "kb_related", "kb_erp_links", "kb_views"]) {
    await query(`DELETE FROM ${t} WHERE article_id = ?`, [id]).catch(() => {})
  }
  await query("DELETE FROM kb_related WHERE related_id = ?", [id]).catch(() => {})
  await query("DELETE FROM kb_articles WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
