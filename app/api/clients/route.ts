import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { ensureClientTables } from "@/lib/clients-db"

const ALLOWED = new Set([
  "salutation","client_name","email","login_allowed","email_notifications","gender","language",
  "mobile","company_name","website","tax_name","gst_number","office_phone","address","city","state",
  "country","postal_code","category","sub_category","currency","status","notes",
])

export async function GET() {
  await ensureClientTables()
  const session = await requireFeature("clients.view_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const clients = await query("SELECT * FROM clients ORDER BY created_at DESC")
  return NextResponse.json({ clients })
}

export async function POST(request: Request) {
  await ensureClientTables()
  const session = await requireFeature("clients.manage_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  if (!body.client_name) return NextResponse.json({ error: "Client name is required" }, { status: 400 })
  if (!body.email) return NextResponse.json({ error: "Email is required" }, { status: 400 })

  const clientCode = await nextRecordId("CLI")
  const fields = ["client_code", ...Object.keys(body).filter((key) => ALLOWED.has(key))]
  const values = fields.map((key) =>
    key === "client_code" ? clientCode : body[key] === "" ? null : body[key],
  )
  await query(
    `INSERT INTO clients (${fields.join(",")},created_by) VALUES (${fields.map(() => "?").join(",")},?)`,
    [...values, session.userId],
  )
  return NextResponse.json({ ok: true, client_code: clientCode }, { status: 201 })
}
