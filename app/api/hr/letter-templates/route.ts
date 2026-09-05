import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureLetterTables } from "@/lib/hr-letters-db"

const fields = ["name", "letter_type", "subject", "body", "status"] as const

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const templates = await query<any[]>("SELECT * FROM hr_letter_templates ORDER BY created_at DESC")
  return NextResponse.json({ templates })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const body = await request.json()
  if (!body.name || !body.subject || !body.body) {
    return NextResponse.json({ error: "Name, subject and body are required" }, { status: 400 })
  }
  const values = fields.map((field) => body[field] ?? (field === "letter_type" ? "Offer Letter" : field === "status" ? "Active" : null))
  try {
    const result = await query<any>(
      `INSERT INTO hr_letter_templates (${fields.join(",")}, created_by) VALUES (${fields.map(() => "?").join(",")}, ?)`,
      [...values, session.userId],
    )
    return NextResponse.json({ id: result.insertId }, { status: 201 })
  } catch (error: any) {
    if (error?.code === "ER_DUP_ENTRY") return NextResponse.json({ error: "A template with this name already exists" }, { status: 409 })
    throw error
  }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "ID is required" }, { status: 400 })
  const updates = fields.filter((field) => Object.prototype.hasOwnProperty.call(body, field))
  if (!updates.length) return NextResponse.json({ error: "No changes provided" }, { status: 400 })
  await query(
    `UPDATE hr_letter_templates SET ${updates.map((field) => `${field} = ?`).join(", ")} WHERE id = ?`,
    [...updates.map((field) => body[field]), body.id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()
  const id = new URL(request.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "ID is required" }, { status: 400 })
  await query("DELETE FROM hr_letter_templates WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}
