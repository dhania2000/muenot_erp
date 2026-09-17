import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureKbSchema, canManage, sanitizeContent, toPlainText, parseTags, syncTags,
  assignArticleCode, audit, snapshotVersion, labelForType,
  CONTENT_TYPES, type ContentType,
} from "@/lib/knowledge-base"

export const dynamic = "force-dynamic"

// Resolve a category by name, creating it on demand (idempotent).
async function resolveCategoryByName(name: string): Promise<number | null> {
  const clean = name.trim().slice(0, 150)
  if (!clean) return null
  await query("INSERT IGNORE INTO kb_categories (name) VALUES (?)", [clean])
  const rows = await query<any[]>("SELECT id FROM kb_categories WHERE name = ? LIMIT 1", [clean])
  return rows[0]?.id ?? null
}

function normalizeType(raw: string): ContentType {
  const key = raw.trim().toLowerCase().replace(/[^a-z]/g, "")
  const match = CONTENT_TYPES.find((t) => t === key || labelForType(t).toLowerCase().replace(/[^a-z]/g, "") === key)
  return (match as ContentType) || "article"
}

// ---------------------------------------------------------------------------
// POST /api/knowledge-base/import — structured bulk import (Phase 82).
// Accepts { rows: [{ heading, summary, content, content_type, category,
// department, subcategory, tags }], fileName? }. Every imported article lands
// as a DRAFT so a manager reviews and publishes it deliberately.
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const body = await request.json().catch(() => ({}))
  const rows = Array.isArray(body?.rows) ? body.rows : []
  const fileName = typeof body?.fileName === "string" ? body.fileName : null
  if (!rows.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 })

  // Existing headings for duplicate detection (case-insensitive).
  const existing = await query<{ heading: string }[]>("SELECT heading FROM kb_articles")
  const existingHeadings = new Set(existing.map((r) => String(r.heading || "").trim().toLowerCase()))
  const seenHeadings = new Set<string>()

  let imported = 0
  let skipped = 0
  const errors: string[] = []
  const categoryCache = new Map<string, number | null>()

  for (let index = 0; index < rows.length; index++) {
    const rowNum = index + 2 // header row + 1-based
    const row = (rows[index] || {}) as Record<string, unknown>

    const heading = String(row.heading || "").trim()
    if (!heading) { errors.push(`Row ${rowNum}: title is required`); continue }
    if (heading.length > 200) { errors.push(`Row ${rowNum}: title is too long (max 200)`); continue }

    const content = sanitizeContent(String(row.content ?? row.summary ?? ""))
    if (!toPlainText(content)) { errors.push(`Row ${rowNum}: content is required`); continue }

    const key = heading.toLowerCase()
    if (existingHeadings.has(key) || seenHeadings.has(key)) {
      skipped++
      errors.push(`Row ${rowNum}: skipped — an article titled "${heading}" already exists`)
      continue
    }

    const summary = String(row.summary || "").trim().slice(0, 600) || toPlainText(content, 200)
    const contentType = normalizeType(String(row.content_type || row.type || ""))

    const categoryName = String(row.category || "").trim()
    let categoryId: number | null = null
    if (categoryName) {
      if (!categoryCache.has(categoryName)) categoryCache.set(categoryName, await resolveCategoryByName(categoryName))
      categoryId = categoryCache.get(categoryName) ?? null
    }

    try {
      const res: any = await query(
        `INSERT INTO kb_articles
           (heading, description, summary, content, category_id, subcategory, content_type, to_type,
            audience_type, audience_config, department, status, version,
            author_id, author_name, owner_id, owner_name,
            acknowledgement_required, notify_in_app, notify_email, pinned, important,
            created_by, created_by_name)
         VALUES (?,?,?,?,?,?,?,'employees','all','{}',?,'draft',1,?,?,?,?,0,1,0,0,0,?,?)`,
        [
          heading, summary, summary, content, categoryId,
          row.subcategory ? String(row.subcategory).slice(0, 120) : null,
          contentType,
          row.department ? String(row.department).slice(0, 150) : null,
          session.userId, session.name, session.userId, session.name,
          session.userId, session.name,
        ],
      )
      const id = res.insertId
      await assignArticleCode(id)
      const tags = parseTags(row.tags)
      if (tags.length) await syncTags(id, tags)

      const article = (await query<any[]>("SELECT * FROM kb_articles WHERE id = ?", [id]))[0]
      await snapshotVersion(article, session, "Imported")
      await audit(id, session, "created", `${labelForType(contentType)} imported as draft${fileName ? ` from ${fileName}` : ""}`)

      imported++
      seenHeadings.add(key)
    } catch {
      errors.push(`Row ${rowNum}: could not import "${heading}"`)
    }
  }

  const failed = errors.filter((e) => !e.includes("skipped")).length

  return NextResponse.json({
    imported,
    failed,
    skipped,
    total: rows.length,
    errors: errors.slice(0, 50),
  })
}
