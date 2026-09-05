import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

type ContactRow = {
  name: string | null
  email: string | null
  company: string | null
  source: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Returns a de-duplicated list of CRM contacts (from leads + companies) that
 * have a valid email, for the meeting attendee picker.
 */
export async function GET() {
  const session = await requireFeature("sales.view_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [leads, companies] = await Promise.all([
    query<ContactRow[]>(
      `SELECT contact_person AS name,
              COALESCE(NULLIF(email, ''), NULLIF(company_email, '')) AS email,
              company_name AS company,
              'lead' AS source
       FROM sales_leads
       WHERE COALESCE(NULLIF(email, ''), NULLIF(company_email, '')) IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 500`,
    ),
    query<ContactRow[]>(
      `SELECT company_name AS name,
              NULLIF(company_email, '') AS email,
              company_name AS company,
              'company' AS source
       FROM sales_companies
       WHERE NULLIF(company_email, '') IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 500`,
    ),
  ])

  const seen = new Set<string>()
  const contacts: ContactRow[] = []
  for (const row of [...leads, ...companies]) {
    const email = (row.email || "").trim().toLowerCase()
    if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue
    seen.add(email)
    contacts.push({
      name: row.name?.trim() || null,
      email,
      company: row.company?.trim() || null,
      source: row.source,
    })
  }

  return NextResponse.json({ contacts })
}
