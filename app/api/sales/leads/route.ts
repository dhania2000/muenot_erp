import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const leads = await query(
    `SELECT l.*, u.name AS assigned_to_name
     FROM sales_leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     ORDER BY l.created_at DESC`,
  )
  return NextResponse.json({ leads })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const { contact_person, email, company_name } = body
  if (!contact_person || !company_name) {
    return NextResponse.json({ error: "Contact person and company name are required" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(lead_code, 5) AS UNSIGNED)), 0) + 1 AS next FROM sales_leads",
  )
  const leadCode = `MLD-${String(next).padStart(3, "0")}`

  const result = await query<any>(
    `INSERT INTO sales_leads
     (lead_code, lead_date, contact_person, contact_number, email, designation, source_url, lead_source,
      company_name, industry, website, company_email, country, assigned_to, status,
      follow_up_date, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      leadCode,
      new Date(),
      contact_person,
      body.contact_number || null,
      email || null,
      body.designation || null,
      body.source_url || null,
      body.lead_source || null,
      company_name,
      body.industry || null,
      body.website || null,
      body.company_email || null,
      body.country || null,
      body.assigned_to || null,
      body.status || "New",
      body.follow_up_date || null,
      body.remarks || null,
      session.userId,
    ],
  )

  return NextResponse.json({ id: result.insertId, lead_code: leadCode })
}
