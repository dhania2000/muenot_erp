import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

const toTypes = ["employees", "clients"] as const
type ToType = (typeof toTypes)[number]

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "knowledge-base.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const where: string[] = []
  const params: unknown[] = []

  // Employees only see articles addressed to employees; admins see everything.
  if (session.role !== "admin") {
    where.push("a.to_type = 'employees'")
  } else if (sp.get("to")) {
    where.push("a.to_type = ?")
    params.push(sp.get("to"))
  }

  const category = sp.get("category")
  if (category && category !== "all") {
    where.push("a.category_id = ?")
    params.push(Number(category))
  }

  const search = sp.get("q")?.trim()
  if (search) {
    where.push("(a.heading LIKE ? OR a.description LIKE ?)")
    params.push(`%${search}%`, `%${search}%`)
  }

  const articles = await query<any[]>(
    `SELECT a.*, c.name AS category_name
     FROM kb_articles a
     LEFT JOIN kb_categories c ON c.id = a.category_id` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY a.created_at DESC",
    params as any[],
  )

  const categories = await query<any[]>("SELECT id, name FROM kb_categories ORDER BY name")
  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "knowledge-base.manage"))
  return NextResponse.json({ articles, categories, canManage })
}

async function requireManage() {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "knowledge-base.manage")))
    return null
  return session
}

async function resolveCategory(body: any): Promise<number | null> {
  if (body.new_category && String(body.new_category).trim()) {
    const name = String(body.new_category).trim()
    await query("INSERT IGNORE INTO kb_categories (name) VALUES (?)", [name])
    const rows = await query<any[]>("SELECT id FROM kb_categories WHERE name = ? LIMIT 1", [name])
    return rows[0]?.id ?? null
  }
  return body.category_id ? Number(body.category_id) : null
}

export async function POST(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const heading = String(body.heading || "").trim()
  const description = String(body.description || "").trim()
  const toType: ToType = toTypes.includes(body.to_type) ? body.to_type : "employees"

  if (!heading || !description) return NextResponse.json({ error: "Heading and description are required" }, { status: 400 })
  if (heading.length > 200) return NextResponse.json({ error: "Heading is too long" }, { status: 400 })

  const categoryId = await resolveCategory(body)

  await query(
    "INSERT INTO kb_articles (heading, description, category_id, to_type, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?)",
    [heading, description, categoryId, toType, session.userId, session.name],
  )
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const id = Number(body.id)
  const heading = String(body.heading || "").trim()
  const description = String(body.description || "").trim()
  const toType: ToType = toTypes.includes(body.to_type) ? body.to_type : "employees"

  if (!id || !heading || !description) return NextResponse.json({ error: "Article, heading and description are required" }, { status: 400 })

  const categoryId = await resolveCategory(body)

  await query(
    "UPDATE kb_articles SET heading = ?, description = ?, category_id = ?, to_type = ? WHERE id = ?",
    [heading, description, categoryId, toType, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = Number(request.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Article id required" }, { status: 400 })
  await query("DELETE FROM kb_articles WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
