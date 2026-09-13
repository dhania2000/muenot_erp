import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

/**
 * Read-only lookups that power the Clients form's company/contact auto-fill.
 *
 * These project the canonical Sales masters (sales_companies / sales_contacts)
 * into the minimal shape the form needs. They are guarded by the Clients view
 * feature (not the Sales one) and degrade to an empty list when the Sales module
 * is absent, so the form always works.
 */
export async function GET(request: Request) {
  const session = await requireFeature("clients.view_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const entity = url.searchParams.get("entity")

  if (entity === "companies") {
    const q = (url.searchParams.get("q") || "").trim()
    const like = `%${q}%`
    const companies = await query(
      `SELECT id, company_code, company_name, legal_name, domain, website, phone,
              address_line, city, state, postal_code
         FROM sales_companies
        WHERE archived_at IS NULL
          ${q ? "AND (company_name LIKE ? OR company_code LIKE ? OR domain LIKE ?)" : ""}
        ORDER BY company_name ASC
        LIMIT 20`,
      q ? [like, like, like] : [],
    ).catch(() => [] as any[])
    return NextResponse.json({ companies })
  }

  if (entity === "contacts") {
    const companyId = Number(url.searchParams.get("company_id"))
    if (!Number.isFinite(companyId) || companyId <= 0) return NextResponse.json({ contacts: [] })
    const contacts = await query(
      `SELECT id, name, title, email, phone, is_primary
         FROM sales_contacts
        WHERE company_id = ?
        ORDER BY is_primary DESC, name ASC`,
      [companyId],
    ).catch(() => [] as any[])
    return NextResponse.json({ contacts })
  }

  return NextResponse.json({ error: "Unknown entity" }, { status: 400 })
}
