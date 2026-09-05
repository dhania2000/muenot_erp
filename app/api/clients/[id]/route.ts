import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureClientTables } from "@/lib/clients-db"

const ALLOWED = new Set([
  "salutation","client_name","email","login_allowed","email_notifications","gender","language",
  "mobile","company_name","website","tax_name","gst_number","office_phone","address","city","state",
  "country","postal_code","category","sub_category","currency","status","notes",
])

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureClientTables()
  const session = await requireFeature("clients.manage_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  const fields = Object.keys(body).filter((key) => ALLOWED.has(key))
  if (fields.length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 })

  const values = fields.map((key) => (body[key] === "" ? null : body[key]))
  await query(
    `UPDATE clients SET ${fields.map((f) => `${f}=?`).join(",")} WHERE id=?`,
    [...values, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureClientTables()
  const session = await requireFeature("clients.manage_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  await query("DELETE FROM clients WHERE id=?", [id])
  return NextResponse.json({ ok: true })
}
