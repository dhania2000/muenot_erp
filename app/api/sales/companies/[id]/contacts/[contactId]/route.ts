import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { recordCompanyContactAudit } from "@/lib/sales/company-master"

const ALLOWED = ["name", "title", "email", "phone", "linkedin_url", "is_primary", "notes"]

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id, contactId } = await params
  const companyId = Number(id)
  const body = await request.json()

  if (body.is_primary) {
    await query(`UPDATE sales_contacts SET is_primary = 0 WHERE company_id = ?`, [companyId])
  }

  const fields: string[] = []
  const values: any[] = []
  for (const key of ALLOWED) {
    if (key in body) {
      fields.push(`\`${key}\` = ?`)
      values.push(key === "is_primary" ? (body[key] ? 1 : 0) : body[key] === "" ? null : body[key])
    }
  }
  if (fields.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 })

  await query(`UPDATE sales_contacts SET ${fields.join(", ")} WHERE id = ? AND company_id = ?`, [
    ...values,
    Number(contactId),
    companyId,
  ])
  await recordCompanyContactAudit(companyId, "contact_updated", "Contact updated", session.userId)
  return NextResponse.json({ success: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id, contactId } = await params
  const companyId = Number(id)
  await query(`DELETE FROM sales_contacts WHERE id = ? AND company_id = ?`, [Number(contactId), companyId])
  await recordCompanyContactAudit(companyId, "contact_removed", "Contact removed", session.userId)
  return NextResponse.json({ success: true })
}
