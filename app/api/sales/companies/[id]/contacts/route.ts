import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureCompanyMasterSchema, recordCompanyContactAudit } from "@/lib/sales/company-master"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureCompanyMasterSchema()
  const { id } = await params
  const contacts = await query(
    `SELECT * FROM sales_contacts WHERE company_id = ? ORDER BY is_primary DESC, name ASC`,
    [Number(id)],
  )
  return NextResponse.json({ contacts })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureCompanyMasterSchema()
  const { id } = await params
  const companyId = Number(id)
  const body = await request.json()
  const name = String(body.name || "").trim()
  if (!name) return NextResponse.json({ error: "Contact name is required" }, { status: 400 })

  if (body.is_primary) {
    await query(`UPDATE sales_contacts SET is_primary = 0 WHERE company_id = ?`, [companyId])
  }

  const result = await query<any>(
    `INSERT INTO sales_contacts (company_id, name, title, email, phone, linkedin_url, is_primary, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      companyId,
      name,
      body.title || null,
      body.email || null,
      body.phone || null,
      body.linkedin_url || null,
      body.is_primary ? 1 : 0,
      body.notes || null,
      session.userId,
    ],
  )
  await recordCompanyContactAudit(companyId, "contact_added", `Contact "${name}" added`, session.userId)
  return NextResponse.json({ id: result.insertId })
}
