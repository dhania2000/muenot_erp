import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { createCompany, findDuplicates, ensureCompanyMasterSchema } from "@/lib/sales/company-master"

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureCompanyMasterSchema()

  const body = await request.json()
  const rows = Array.isArray(body?.rows) ? body.rows : []
  if (rows.length === 0) {
    return NextResponse.json({ error: "No rows to import" }, { status: 400 })
  }

  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNumber = i + 2 // account for header row
    const companyName = String(row.company_name || "").trim()

    if (!companyName) {
      errors.push(`Row ${rowNumber}: company name is required`)
      continue
    }

    // Skip obvious duplicates instead of creating them.
    const dupes = await findDuplicates({
      company_name: companyName,
      website: row.website,
      company_email: row.company_email,
    })
    if (dupes.length > 0) {
      skipped += 1
      continue
    }

    const foundedYear = row.founded_year ? Number.parseInt(row.founded_year, 10) : null
    const employeeCount = row.employee_count ? Number.parseInt(row.employee_count, 10) : null

    try {
      await createCompany(
        {
          company_name: companyName,
          industry: row.industry || null,
          website: row.website || null,
          linkedin_url: row.linkedin_url || null,
          company_email: row.company_email || null,
          country: row.country || null,
          company_type: row.company_type || null,
          status: row.status || "New",
          priority: row.priority || null,
          founded_year: Number.isFinite(foundedYear) ? foundedYear : null,
          employee_count: Number.isFinite(employeeCount) ? employeeCount : null,
        },
        session.userId,
        { allowDuplicate: true },
      )
      imported += 1
    } catch {
      errors.push(`Row ${rowNumber}: failed to import "${companyName}"`)
    }
  }

  return NextResponse.json({ imported, skipped, failed: errors.length, errors: errors.slice(0, 20) })
}
