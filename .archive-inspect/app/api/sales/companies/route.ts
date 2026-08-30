import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("sales.view_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const companies = await query(
    `SELECT c.*, u.name AS assigned_to_name
     FROM sales_companies c
     LEFT JOIN users u ON u.id = c.assigned_to
     ORDER BY c.created_at DESC`,
  )
  return NextResponse.json({ companies })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  if (!body.company_name) {
    return NextResponse.json({ error: "Company name is required" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(company_code, 6) AS UNSIGNED)), 0) + 1 AS next FROM sales_companies",
  )
  const companyCode = `MCLD-${String(next).padStart(3, "0")}`

  const result = await query<any>(
    `INSERT INTO sales_companies
     (company_code, company_date, company_name, industry, website, linkedin_url, company_email,
      country, assigned_to, company_type, status, priority, founded_year, employee_count, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      companyCode,
      new Date().toISOString().slice(0, 10),
      body.company_name,
      body.industry || null,
      body.website || null,
      body.linkedin_url || null,
      body.company_email || null,
      body.country || null,
      body.assigned_to || null,
      body.company_type || null,
      body.status || "New",
      body.priority || null,
      body.founded_year || null,
      body.employee_count || null,
      session.userId,
    ],
  )

  return NextResponse.json({ id: result.insertId, company_code: companyCode })
}
