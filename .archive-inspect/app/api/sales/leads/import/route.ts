import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

const VALID_STATUSES = new Set([
  "New",
  "Follow Up 1",
  "Follow Up 2",
  "In Discussion",
  "Proposal Sent",
  "Ready",
  "Won",
  "Lost",
])

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const rows = Array.isArray(body?.rows) ? body.rows : []
  if (rows.length === 0) {
    return NextResponse.json({ error: "No rows to import" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(lead_code, 5) AS UNSIGNED)), 0) + 1 AS next FROM sales_leads",
  )
  let nextCode = next

  let imported = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNumber = i + 2 // account for header row
    const contactPerson = String(row.contact_person || "").trim()
    const companyName = String(row.company_name || "").trim()

    if (!contactPerson || !companyName) {
      errors.push(`Row ${rowNumber}: contact person and company name are required`)
      continue
    }

    const status = VALID_STATUSES.has(row.status) ? row.status : "New"
    const leadCode = `MLD-${String(nextCode).padStart(3, "0")}`

    try {
      await query(
        `INSERT INTO sales_leads
         (lead_code, lead_date, contact_person, contact_number, email, designation, lead_source,
          company_name, industry, website, company_email, country, status, follow_up_date, remarks, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          leadCode,
          row.lead_date || new Date().toISOString().slice(0, 10),
          contactPerson,
          row.contact_number || null,
          row.email || null,
          row.designation || null,
          row.lead_source || null,
          companyName,
          row.industry || null,
          row.website || null,
          row.company_email || null,
          row.country || null,
          status,
          row.follow_up_date || null,
          row.remarks || null,
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
