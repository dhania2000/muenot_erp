import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const rows = Array.isArray(body?.rows) ? body.rows : []
  if (rows.length === 0) {
    return NextResponse.json({ error: "No rows to import" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(company_code, 6) AS UNSIGNED)), 0) + 1 AS next FROM sales_companies",
  )
  let nextCode = next

  let imported = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNumber = i + 2 // account for header row
    const companyName = String(row.company_name || "").trim()

    if (!companyName) {
      errors.push(`Row ${rowNumber}: company name is required`)
      continue
    }

    const companyCode = `MCLD-${String(nextCode).padStart(3, "0")}`
    const foundedYear = row.founded_year ? Number.parseInt(row.founded_year, 10) : null
    const employeeCount = row.employee_count ? Number.parseInt(row.employee_count, 10) : null

    try {
      await query(
        `INSERT INTO sales_companies
         (company_code, company_date, company_name, industry, website, linkedin_url, company_email,
          country, company_type, status, priority, founded_year, employee_count, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyCode,
          new Date().toISOString().slice(0, 10),
          companyName,
          row.industry || null,
          row.website || null,
          row.linkedin_url || null,
          row.company_email || null,
          row.country || null,
          row.company_type || null,
          row.status || "New",
          row.priority || null,
          Number.isFinite(foundedYear) ? foundedYear : null,
          Number.isFinite(employeeCount) ? employeeCount : null,
          session.userId,
        ],
      )
      nextCode += 1
      imported += 1
    } catch {
      errors.push(`Row ${rowNumber}: failed to import "${companyName}"`)
    }
  }

  return NextResponse.json({ imported, failed: errors.length, errors: errors.slice(0, 20) })
}
