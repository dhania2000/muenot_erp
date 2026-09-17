import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureKbSchema, canManage, audit } from "@/lib/knowledge-base"

export const dynamic = "force-dynamic"

// ---------------------------------------------------------------------------
// GET /api/knowledge-base/categories — full category register with usage
// counts (manager only). Powers the Settings → Categories manager.
// ---------------------------------------------------------------------------
export async function GET() {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const rows = await query<any[]>(
    `SELECT c.id, c.name, c.active, c.sort_order,
            (SELECT COUNT(*) FROM kb_articles a WHERE a.category_id = c.id) AS article_count
       FROM kb_categories c ORDER BY c.sort_order, c.name`,
  )
  return NextResponse.json({
    categories: rows.map((c) => ({
      id: c.id,
      name: c.name,
      active: !!c.active,
      sort_order: c.sort_order,
      article_count: Number(c.article_count ?? 0),
    })),
  })
}

// POST — create a category. Duplicate names are rejected server-side.
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const body = await request.json().catch(() => ({}))
  const name = String(body.name || "").trim().slice(0, 150)
  if (!name) return NextResponse.json({ error: "Category name is required" }, { status: 400 })

  const existing = await query<any[]>("SELECT id FROM kb_categories WHERE name = ? LIMIT 1", [name])
  if (existing.length) return NextResponse.json({ error: "A category with that name already exists" }, { status: 409 })

  const [maxRow] = await query<any[]>("SELECT COALESCE(MAX(sort_order), 0) AS m FROM kb_categories")
  const res: any = await query("INSERT INTO kb_categories (name, sort_order, active) VALUES (?, ?, 1)", [
    name,
    Number(maxRow?.m ?? 0) + 1,
  ])
  await audit(null, session, "category_created", `Category "${name}" created`)
  return NextResponse.json({ ok: true, id: res.insertId }, { status: 201 })
}

// PATCH — rename, activate/deactivate, or reorder a category.
export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const body = await request.json().catch(() => ({}))
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: "Category id required" }, { status: 400 })
  const current = (await query<any[]>("SELECT * FROM kb_categories WHERE id = ? LIMIT 1", [id]))[0]
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const sets: string[] = []
  const params: unknown[] = []
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 150)
    if (!name) return NextResponse.json({ error: "Category name cannot be empty" }, { status: 400 })
    const dupe = await query<any[]>("SELECT id FROM kb_categories WHERE name = ? AND id <> ? LIMIT 1", [name, id])
    if (dupe.length) return NextResponse.json({ error: "A category with that name already exists" }, { status: 409 })
    sets.push("name = ?")
    params.push(name)
  }
  if (body.active !== undefined) {
    sets.push("active = ?")
    params.push(body.active ? 1 : 0)
  }
  if (body.sort_order !== undefined) {
    sets.push("sort_order = ?")
    params.push(Number(body.sort_order) || 0)
  }
  if (!sets.length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })

  params.push(id)
  await query(`UPDATE kb_categories SET ${sets.join(", ")} WHERE id = ?`, params)
  await audit(null, session, "category_updated", `Category "${current.name}" updated`)
  return NextResponse.json({ ok: true })
}

// DELETE — remove a category only when no articles reference it. Otherwise the
// caller should deactivate it instead (keeps historical article links intact).
export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const id = Number(new URL(request.url).searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Category id required" }, { status: 400 })
  const current = (await query<any[]>("SELECT * FROM kb_categories WHERE id = ? LIMIT 1", [id]))[0]
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [used] = await query<any[]>("SELECT COUNT(*) AS c FROM kb_articles WHERE category_id = ?", [id])
  if (Number(used?.c ?? 0) > 0)
    return NextResponse.json(
      { error: "This category is in use. Deactivate it instead of deleting.", code: "in_use" },
      { status: 409 },
    )

  await query("DELETE FROM kb_categories WHERE id = ?", [id])
  await audit(null, session, "category_deleted", `Category "${current.name}" deleted`)
  return NextResponse.json({ ok: true })
}
