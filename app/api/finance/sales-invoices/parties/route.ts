import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getSettings } from "@/lib/settings/server"
import { stateCodeFromGstin } from "@/lib/sales-invoice-compute"

/**
 * Party (client) auto-fill for the Sales Invoice form.
 *
 * CRM `clients` is the canonical party. Where a matching finance
 * `customers_vendors` record exists (by GSTIN, then name) we enrich the payload
 * with the finance-only fields the clients table does not hold — payment terms,
 * credit limit, TDS section/rate, state code and registration type — so the
 * user never re-types data the ERP already knows.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const search = (req.nextUrl.searchParams.get("search") || "").trim()
  const like = `%${search}%`
  const settings = await getSettings()
  const defaultDueDays = Number(settings["finance.due_days"]) || 15

  const clients = (await query(
    `SELECT client_code, client_name, company_name, email, mobile, gst_number, tax_name,
            address, city, state, country, postal_code, currency, finance_party_id
       FROM clients
       WHERE archived_at IS NULL
       ${search ? "AND (client_name LIKE ? OR company_name LIKE ? OR client_code LIKE ? OR gst_number LIKE ?)" : ""}
       ORDER BY client_name ASC
       LIMIT 50`,
    search ? [like, like, like, like] : [],
  )) as any[]

  // Load finance parties once and index them for enrichment.
  const parties = (await query(
    `SELECT party_id, customer_name, legal_name, gstin, pan, state, state_code,
            payment_terms_days, credit_limit, currency, tds_section, tds_rate,
            gst_registration_type
       FROM customers_vendors`,
  )) as any[]
  const byId = new Map<string, any>()
  const byGstin = new Map<string, any>()
  const byName = new Map<string, any>()
  for (const pt of parties) {
    if (pt.party_id) byId.set(String(pt.party_id), pt)
    if (pt.gstin) byGstin.set(String(pt.gstin).toUpperCase(), pt)
    if (pt.customer_name) byName.set(String(pt.customer_name).toLowerCase(), pt)
  }

  const rows = clients.map((c) => {
    // Prefer the explicit finance-party link stored on the client; fall back to
    // matching by GSTIN, then name, for rows created before linking existed.
    const match =
      (c.finance_party_id && byId.get(String(c.finance_party_id))) ||
      (c.gst_number && byGstin.get(String(c.gst_number).toUpperCase())) ||
      byName.get(String(c.company_name || c.client_name || "").toLowerCase()) ||
      null
    const stateCode = match?.state_code || stateCodeFromGstin(c.gst_number) || null
    const paymentTermsDays = match?.payment_terms_days ? Number(match.payment_terms_days) : defaultDueDays
    return {
      client_id: c.client_code,
      client_name: c.company_name || c.client_name,
      contact_person: c.client_name,
      email: c.email,
      phone: c.mobile,
      gstin: c.gst_number || match?.gstin || "",
      tax_label: c.tax_name || "GSTIN",
      pan: match?.pan || "",
      address: c.address,
      city: c.city,
      state: c.state || match?.state || "",
      state_code: stateCode,
      country: c.country,
      postal_code: c.postal_code,
      currency: c.currency || match?.currency || settings["currency.code"] || "INR",
      place_of_supply: [c.state, stateCode].filter(Boolean).join(" - ") || c.state || "",
      place_of_supply_code: stateCode,
      payment_terms_days: Number.isFinite(paymentTermsDays) ? paymentTermsDays : defaultDueDays,
      credit_limit: match?.credit_limit != null ? Number(match.credit_limit) : null,
      tds_section: match?.tds_section || "",
      tds_rate: match?.tds_rate != null ? Number(match.tds_rate) : 0,
      gst_registration_type: match?.gst_registration_type || "",
      customer_party_id: match?.party_id || null,
    }
  })

  return NextResponse.json({ parties: rows })
}
