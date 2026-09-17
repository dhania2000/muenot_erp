import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureKbSchema, canExport } from "@/lib/knowledge-base"

export const dynamic = "force-dynamic"

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// GET /api/knowledge-base/export — CSV of the article register (manager only).
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || !(await canExport(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const url = new URL(request.url)
  const status = url.searchParams.get("status") || ""
  const contentType = url.searchParams.get("content_type") || ""
  const where: string[] = ["1=1"]
  const params: unknown[] = []
  if (status && status !== "all") { where.push("a.status = ?"); params.push(status) }
  if (contentType && contentType !== "all") { where.push("a.content_type = ?"); params.push(contentType) }

  const rows = await query<any[]>(
    `SELECT a.article_code, a.heading, a.content_type, c.name AS category, a.status,
            a.audience_type, a.department, a.author_name, a.owner_name, a.version,
            a.created_at, a.published_at, a.review_date, a.expiry_date, a.view_count,
            a.helpful_count, a.not_helpful_count,
            (SELECT COUNT(*) FROM kb_recipients r WHERE r.article_id = a.id) AS recipients,
            (SELECT COUNT(*) FROM kb_reads rd WHERE rd.article_id = a.id) AS reads,
            (SELECT COUNT(*) FROM kb_acknowledgements ak WHERE ak.article_id = a.id) AS acks
     FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id
     WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC`,
    params,
  )

  const headers = [
    "Code", "Title", "Type", "Category", "Status", "Audience", "Department", "Author", "Owner", "Version",
    "Created", "Published", "Review Date", "Expiry Date", "Views", "Helpful", "Not Helpful", "Recipients", "Reads", "Acks",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push([
      r.article_code, r.heading, r.content_type, r.category, r.status, r.audience_type, r.department,
      r.author_name, r.owner_name, r.version, r.created_at, r.published_at, r.review_date, r.expiry_date,
      r.view_count, r.helpful_count, r.not_helpful_count, r.recipients, r.reads, r.acks,
    ].map(csvCell).join(","))
  }
  const csv = lines.join("\n")

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="knowledge-base-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
