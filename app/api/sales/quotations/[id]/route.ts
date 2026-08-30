import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

const ALLOWED = [
  "company_name",
  "contact_person",
  "opportunity_name",
  "total_amount",
  "valid_until",
  "status",
]

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()

  const fields: string[] = []
  const values: any[] = []
  for (const key of ALLOWED) {
    if (key in body) {
      fields.push(`${key} = ?`)
      values.push(body[key] === "" ? null : body[key])
    }
  }
  if (fields.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 })

  await query(`UPDATE sales_quotations SET ${fields.join(", ")} WHERE id = ?`, [...values, id])
  return NextResponse.json({ success: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  await query("DELETE FROM sales_quotations WHERE id = ?", [id])
  return NextResponse.json({ success: true })
}
