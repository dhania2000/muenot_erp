import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureOnboardingSchema, listTemplates } from "@/lib/sales/onboarding-service"

/**
 * GET /api/sales/onboarding/lookups — relational pickers for the create/edit
 * dialog. Each list carries enough embedded fields (company_id, value,
 * currency, source ids, owner) that selecting a contract can auto-fill the rest
 * client-side. The server re-resolves and validates the graph on save, so these
 * are purely for UX. Every query is defensive so a schema variance in one master
 * never blanks the whole picker.
 *
 * Optional ?companyId= narrows contacts to a company.
 */
export async function GET(request: Request) {
  const session = await requireFeature("sales.view_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureOnboardingSchema()
  const companyId = new URL(request.url).searchParams.get("companyId")

  const [companies, contracts, quotations, leads, contacts, users, templates] = await Promise.all([
    query<any[]>(
      `SELECT id, company_code, company_name, industry, website, company_email, currency, assigned_to AS owner_id
       FROM sales_companies
       WHERE archived_at IS NULL
       ORDER BY company_name ASC LIMIT 1000`,
    ).catch(() => []),
    query<any[]>(
      `SELECT id, contract_code, company_id, company_name, value AS contract_value, contract_type,
              start_date, end_date, source_quotation_id, added_by AS owner_id, status
       FROM sales_contracts
       ORDER BY created_at DESC LIMIT 1000`,
    ).catch(() => []),
    query<any[]>(
      `SELECT id, quote_code, company_id, company_name, total_amount, status
       FROM sales_quotations
       ORDER BY created_at DESC LIMIT 1000`,
    ).catch(() => []),
    query<any[]>(
      `SELECT id, lead_code, company_id, company_name, contact_person, status
       FROM sales_leads
       WHERE archived_at IS NULL
       ORDER BY created_at DESC LIMIT 1000`,
    ).catch(() => []),
    companyId
      ? query<any[]>(
          `SELECT id, company_id, name, is_primary FROM sales_contacts WHERE company_id = ? ORDER BY is_primary DESC, name ASC`,
          [Number(companyId)],
        ).catch(() => [])
      : query<any[]>(
          `SELECT id, company_id, name, is_primary FROM sales_contacts ORDER BY name ASC LIMIT 1000`,
        ).catch(() => []),
    query<any[]>(`SELECT id, name FROM users WHERE status = 'active' ORDER BY name ASC`).catch(() => []),
    listTemplates().catch(() => []),
  ])

  return NextResponse.json({ companies, contracts, quotations, leads, contacts, users, templates })
}
