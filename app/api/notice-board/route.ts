import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

const toTypes = ["employees", "clients"] as const
type ToType = (typeof toTypes)[number]

async function loadDepartments(): Promise<string[]> {
  try {
    const rows = await query<any[]>(
      "SELECT DISTINCT department FROM hr_employees WHERE department IS NOT NULL AND department <> '' ORDER BY department",
    )
    return rows.map((r) => r.department)
  } catch {
    return []
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "notice-board.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const where: string[] = []
  const params: unknown[] = []

  // Employees only see notices addressed to employees; admins see everything.
  if (session.role !== "admin") {
    where.push("to_type = 'employees'")
  } else if (sp.get("to")) {
    where.push("to_type = ?")
    params.push(sp.get("to"))
  }

  const search = sp.get("q")?.trim()
  if (search) {
    where.push("(heading LIKE ? OR description LIKE ?)")
    params.push(`%${search}%`, `%${search}%`)
  }
  if (sp.get("from")) {
    where.push("created_at >= ?")
    params.push(sp.get("from"))
  }
  if (sp.get("to_date")) {
    where.push("created_at <= ?")
    params.push(`${sp.get("to_date")} 23:59:59`)
  }

  const notices = await query<any[]>(
    "SELECT * FROM notices" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY created_at DESC",
    params as any[],
  )

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "notice-board.manage"))
  return NextResponse.json({ notices, departments: await loadDepartments(), canManage })
}

async function requireManage() {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "notice-board.manage")))
    return null
  return session
}

export async function POST(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const heading = String(body.heading || "").trim()
  const description = String(body.description || "").trim()
  const toType: ToType = toTypes.includes(body.to_type) ? body.to_type : "employees"
  const department = toType === "employees" && body.department ? String(body.department).trim() : null

  if (!heading || !description) return NextResponse.json({ error: "Heading and details are required" }, { status: 400 })
  if (heading.length > 200) return NextResponse.json({ error: "Heading is too long" }, { status: 400 })

  await query(
    "INSERT INTO notices (heading, description, to_type, department, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?)",
    [heading, description, toType, department, session.userId, session.name],
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
  const department = toType === "employees" && body.department ? String(body.department).trim() : null

  if (!id || !heading || !description) return NextResponse.json({ error: "Notice, heading and details are required" }, { status: 400 })

  await query(
    "UPDATE notices SET heading = ?, description = ?, to_type = ?, department = ? WHERE id = ?",
    [heading, description, toType, department, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const session = await requireManage()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = Number(request.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Notice id required" }, { status: 400 })
  await query("DELETE FROM notices WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
