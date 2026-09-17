import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureKbSchema, canView, canManage, canApprove, canViewAnalytics, resolveEmployee,
  employeeCanSee, markRead, acknowledge, recordView, setFeedback, toggleFavorite,
  materializeRecipients, dispatchArticle, statusForPublish, audit, snapshotVersion,
  getAnalytics, getRecipientStatus, getFeedback, assignArticleCode, labelForType,
  sanitizeContent, toPlainText,
} from "@/lib/knowledge-base"

export const dynamic = "force-dynamic"

async function loadArticle(id: number) {
  const rows = await query<any[]>(
    `SELECT a.*, c.name AS category_name FROM kb_articles a
     LEFT JOIN kb_categories c ON c.id = a.category_id WHERE a.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// GET /api/knowledge-base/[id] — full article detail (authorized).
// ---------------------------------------------------------------------------
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const id = Number((await params).id)
  const article = await loadArticle(id)
  if (!article) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const manage = await canManage(session)
  const emp = await resolveEmployee(session)

  if (!manage) {
    // Server-side visibility — never trust the client (Phase 13, 75, 76).
    if (!(await employeeCanSee(id, emp))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Record view + mark read for recipients (idempotent).
  await recordView(id, emp?.id ?? null)
  let isRead = false, isAck = false, isFavorite = false
  if (emp) {
    const rec = await query<any[]>("SELECT id FROM kb_recipients WHERE article_id = ? AND employee_id = ? LIMIT 1", [id, emp.id])
    if (rec.length || manage) { await markRead(id, emp.id) }
    const [[r], [k], [f]] = await Promise.all([
      query<any[]>("SELECT id FROM kb_reads WHERE article_id = ? AND employee_id = ?", [id, emp.id]),
      query<any[]>("SELECT id FROM kb_acknowledgements WHERE article_id = ? AND employee_id = ?", [id, emp.id]),
      query<any[]>("SELECT id FROM kb_favorites WHERE article_id = ? AND employee_id = ?", [id, emp.id]),
    ])
    isRead = !!r; isAck = !!k; isFavorite = !!f
  }

  const [attachments, tags, related, erpLinks] = await Promise.all([
    query<any[]>("SELECT id, file_name, file_type, file_size FROM kb_attachments WHERE article_id = ? ORDER BY id", [id]),
    query<any[]>("SELECT tag FROM kb_tags WHERE article_id = ? ORDER BY tag", [id]),
    query<any[]>(
      `SELECT r.related_id AS id, a.article_code, a.heading, a.content_type, a.status
         FROM kb_related r JOIN kb_articles a ON a.id = r.related_id WHERE r.article_id = ?`,
      [id],
    ),
    query<any[]>("SELECT source_module, source_record_id, label FROM kb_erp_links WHERE article_id = ?", [id]),
  ])

  // Related articles the employee cannot see are hidden (Phase 70).
  const visibleRelated = manage ? related : []
  if (!manage) {
    for (const r of related) {
      if (await employeeCanSee(r.id, emp)) visibleRelated.push(r)
    }
  }

  let versions: any[] = []
  let analytics: any = null
  let recipientStatus: any[] = []
  let feedback: any[] = []
  if (manage) {
    versions = await query<any[]>(
      `SELECT version, heading, status, change_summary, edited_by_name, edited_at
         FROM kb_versions WHERE article_id = ? ORDER BY version DESC`,
      [id],
    )
    if (await canViewAnalytics(session)) {
      analytics = await getAnalytics(id)
      recipientStatus = await getRecipientStatus(id)
      feedback = await getFeedback(id)
    }
  }

  return NextResponse.json({
    article: {
      ...article,
      content: article.content || article.description,
      tags: tags.map((t) => t.tag),
    },
    attachments,
    related: visibleRelated,
    erpLinks,
    versions,
    analytics,
    recipientStatus,
    feedback,
    canManage: manage,
    canApprove: await canApprove(session),
    userState: { isRead, isAck, isFavorite },
  })
}

// ---------------------------------------------------------------------------
// POST /api/knowledge-base/[id] — workflow + interaction actions.
// body: { action: "read" | "acknowledge" | "feedback" | "favorite" |
//                  "submit" | "approve" | "reject" | "publish" | "archive" |
//                  "unarchive" | "pin" | "unpin" | "duplicate", ... }
// ---------------------------------------------------------------------------
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureKbSchema()

  const id = Number((await params).id)
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")
  const article = await loadArticle(id)
  if (!article) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const manage = await canManage(session)
  const emp = await resolveEmployee(session)

  // --- Employee interactions (require visibility) ---
  if (["read", "acknowledge", "feedback", "favorite"].includes(action)) {
    if (!(await canView(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (!manage && !(await employeeCanSee(id, emp))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (!emp) return NextResponse.json({ error: "No linked employee record" }, { status: 400 })

    if (action === "read") { await markRead(id, emp.id); return NextResponse.json({ ok: true }) }
    if (action === "acknowledge") {
      await acknowledge(id, emp.id)
      await audit(id, session, "acknowledged", `Acknowledged by employee ${emp.id}`)
      return NextResponse.json({ ok: true })
    }
    if (action === "feedback") {
      await setFeedback(id, emp.id, !!body.helpful, body.comment ? String(body.comment) : null)
      return NextResponse.json({ ok: true })
    }
    if (action === "favorite") {
      const fav = await toggleFavorite(id, emp.id)
      return NextResponse.json({ ok: true, favorite: fav })
    }
  }

  // --- Management / workflow actions ---
  if (!manage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  switch (action) {
    case "submit": {
      if (!["draft", "rejected"].includes(article.status))
        return NextResponse.json({ error: `Cannot submit a ${article.status} article` }, { status: 409 })
      await query("UPDATE kb_articles SET status = 'in_review', reject_reason = NULL WHERE id = ?", [id])
      await audit(id, session, "submitted", "Submitted for review")
      return NextResponse.json({ ok: true, status: "in_review" })
    }
    case "approve": {
      if (!(await canApprove(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      if (article.status !== "in_review")
        return NextResponse.json({ error: `Cannot approve a ${article.status} article` }, { status: 409 })
      // Approved → publish or schedule depending on publish_date.
      const status = statusForPublish(article.publish_date, article.expiry_date)
      if (status === "expired")
        return NextResponse.json({ error: "Expiry date is in the past — update it before approving" }, { status: 400 })
      await query(
        "UPDATE kb_articles SET status = ?, published_at = ?, reviewer_id = ?, reviewer_name = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?",
        [status, status === "published" ? new Date() : null, session.userId, session.name, body.note ? String(body.note).slice(0, 1000) : null, id],
      )
      await assignArticleCode(id)
      const refreshed = await loadArticle(id)
      await materializeRecipients(id, refreshed)
      await audit(id, session, "approved", `Approved → ${status}`)
      let dispatch = null
      if (status === "published") dispatch = await dispatchArticle(id, new URL(request.url).origin)
      return NextResponse.json({ ok: true, status, dispatch })
    }
    case "reject": {
      if (!(await canApprove(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      if (article.status !== "in_review")
        return NextResponse.json({ error: `Cannot reject a ${article.status} article` }, { status: 409 })
      await query(
        "UPDATE kb_articles SET status = 'rejected', reviewer_id = ?, reviewer_name = ?, reviewed_at = NOW(), reject_reason = ? WHERE id = ?",
        [session.userId, session.name, body.reason ? String(body.reason).slice(0, 1000) : "Changes requested", id],
      )
      await audit(id, session, "rejected", body.reason ? String(body.reason).slice(0, 500) : "Changes requested")
      return NextResponse.json({ ok: true, status: "rejected" })
    }
    case "publish": {
      if (!["draft", "scheduled", "rejected", "in_review"].includes(article.status))
        return NextResponse.json({ error: `Cannot publish a ${article.status} article` }, { status: 409 })
      if (!toPlainText(article.content || article.description))
        return NextResponse.json({ error: "Content is required to publish" }, { status: 400 })
      const status = statusForPublish(article.publish_date, article.expiry_date)
      if (status === "expired")
        return NextResponse.json({ error: "Expiry date is in the past — update it before publishing" }, { status: 400 })
      await query(
        "UPDATE kb_articles SET status = ?, published_at = ? WHERE id = ?",
        [status, status === "published" ? new Date() : null, id],
      )
      await assignArticleCode(id)
      const refreshed = await loadArticle(id)
      await materializeRecipients(id, refreshed)
      await audit(id, session, status === "scheduled" ? "scheduled" : "published", `Status: ${status}`)
      let dispatch = null
      if (status === "published") dispatch = await dispatchArticle(id, new URL(request.url).origin)
      return NextResponse.json({ ok: true, status, dispatch })
    }
    case "archive": {
      await query("UPDATE kb_articles SET status = 'archived' WHERE id = ?", [id])
      await audit(id, session, "archived", "Archived")
      return NextResponse.json({ ok: true, status: "archived" })
    }
    case "unarchive": {
      await query("UPDATE kb_articles SET status = 'draft' WHERE id = ? AND status = 'archived'", [id])
      await audit(id, session, "unarchived", "Restored to draft")
      return NextResponse.json({ ok: true, status: "draft" })
    }
    case "pin": {
      await query("UPDATE kb_articles SET pinned = 1, keep_pinned_after_expiry = ? WHERE id = ?", [body.keep ? 1 : 0, id])
      await audit(id, session, "pinned", "Pinned")
      return NextResponse.json({ ok: true })
    }
    case "unpin": {
      await query("UPDATE kb_articles SET pinned = 0 WHERE id = ?", [id])
      await audit(id, session, "unpinned", "Unpinned")
      return NextResponse.json({ ok: true })
    }
    case "duplicate": {
      // Duplicate as a fresh draft, preserving source reference (Phase 93).
      const res: any = await query(
        `INSERT INTO kb_articles
           (heading, description, summary, content, category_id, subcategory, content_type, to_type,
            audience_type, audience_config, department, status, version,
            author_id, author_name, owner_id, owner_name, acknowledgement_required,
            notify_in_app, notify_email, important, source_module, source_record_id,
            duplicated_from, created_by, created_by_name)
         SELECT CONCAT(heading, ' (Copy)'), description, summary, content, category_id, subcategory, content_type, to_type,
            audience_type, audience_config, department, 'draft', 1,
            ?, ?, owner_id, owner_name, acknowledgement_required,
            notify_in_app, notify_email, important, source_module, source_record_id,
            id, ?, ?
         FROM kb_articles WHERE id = ?`,
        [session.userId, session.name, session.userId, session.name, id],
      )
      const newId = res.insertId
      await assignArticleCode(newId)
      // Copy tags.
      await query("INSERT IGNORE INTO kb_tags (article_id, tag) SELECT ?, tag FROM kb_tags WHERE article_id = ?", [newId, id])
      const dup = await loadArticle(newId)
      await snapshotVersion(dup, session, `Duplicated from ${article.article_code || id}`)
      await audit(newId, session, "duplicated", `Duplicated from article ${id}`)
      return NextResponse.json({ ok: true, id: newId, status: "draft" })
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }
}
