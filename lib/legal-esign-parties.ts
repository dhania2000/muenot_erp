import "server-only"
import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Legal E-sign — party resolver (server-only).
//
// Looks up signer identity + registered email from the EXISTING masters
// (employees, clients, customers_vendors). It never creates a parallel party
// store (Phases 6, 56, 57). Queries are defensive: column layouts vary across
// deployments, so each lookup degrades gracefully rather than throwing.
// ---------------------------------------------------------------------------

export type PartyKind = "employee" | "client" | "vendor"

export type PartyOption = {
  id: string
  name: string
  email: string | null
  mobile: string | null
  subtitle: string | null
}

const like = (s: string) => `%${s}%`

/** Search internal employees for the signer picker + authorized-signatory link. */
export async function searchEmployees(term: string, limit = 20): Promise<PartyOption[]> {
  try {
    const rows = await query<any[]>(
      `SELECT id, employee_id, name, designation, department, email, official_email, mobile, status
         FROM employees
        WHERE (? = '' OR name LIKE ? OR employee_id LIKE ? OR email LIKE ? OR official_email LIKE ?)
        ORDER BY name ASC LIMIT ?`,
      [term, like(term), like(term), like(term), like(term), limit],
    )
    return rows.map((r) => ({
      id: String(r.id),
      name: r.name || r.employee_id || `Employee #${r.id}`,
      email: r.official_email || r.email || null,
      mobile: r.mobile || null,
      subtitle: [r.designation, r.department].filter(Boolean).join(" · ") || r.employee_id || null,
    }))
  } catch (error) {
    console.error("[v0] searchEmployees failed:", (error as Error).message)
    return []
  }
}

export async function getEmployee(id: string): Promise<PartyOption | null> {
  try {
    const rows = await query<any[]>(
      `SELECT id, employee_id, name, designation, department, email, official_email, mobile
         FROM employees WHERE id = ? OR employee_id = ? LIMIT 1`,
      [id, id],
    )
    const r = rows[0]
    if (!r) return null
    return {
      id: String(r.id),
      name: r.name || r.employee_id || `Employee #${r.id}`,
      email: r.official_email || r.email || null,
      mobile: r.mobile || null,
      subtitle: [r.designation, r.department].filter(Boolean).join(" · ") || null,
    }
  } catch {
    return null
  }
}

/** Search clients (Sales / Clients master). */
export async function searchClients(term: string, limit = 20): Promise<PartyOption[]> {
  try {
    const rows = await query<any[]>(
      `SELECT id, client_code, client_name, company_name, email, primary_contact, mobile, phone
         FROM clients
        WHERE (? = '' OR client_name LIKE ? OR company_name LIKE ? OR client_code LIKE ? OR email LIKE ?)
        ORDER BY COALESCE(NULLIF(company_name,''), client_name) ASC LIMIT ?`,
      [term, like(term), like(term), like(term), like(term), limit],
    )
    return rows.map((r) => ({
      id: String(r.id),
      name: r.company_name || r.client_name || r.client_code || `Client #${r.id}`,
      email: r.email || null,
      mobile: r.mobile || r.phone || null,
      subtitle: [r.primary_contact, r.client_code].filter(Boolean).join(" · ") || null,
    }))
  } catch (error) {
    console.error("[v0] searchClients failed:", (error as Error).message)
    return []
  }
}

export async function getClient(id: string): Promise<PartyOption | null> {
  try {
    const rows = await query<any[]>(
      `SELECT id, client_code, client_name, company_name, email, primary_contact, mobile, phone
         FROM clients WHERE id = ? OR client_code = ? LIMIT 1`,
      [id, id],
    )
    const r = rows[0]
    if (!r) return null
    return {
      id: String(r.id),
      name: r.company_name || r.client_name || r.client_code || `Client #${r.id}`,
      email: r.email || null,
      mobile: r.mobile || r.phone || null,
      subtitle: [r.primary_contact, r.client_code].filter(Boolean).join(" · ") || null,
    }
  } catch {
    return null
  }
}

/** Search vendors (Finance customers_vendors master). */
export async function searchVendors(term: string, limit = 20): Promise<PartyOption[]> {
  try {
    const rows = await query<any[]>(
      `SELECT party_id, customer_name, legal_name, email, contact_email, mobile, phone, gstin
         FROM customers_vendors
        WHERE (? = '' OR customer_name LIKE ? OR legal_name LIKE ? OR party_id LIKE ? OR gstin LIKE ?)
        ORDER BY customer_name ASC LIMIT ?`,
      [term, like(term), like(term), like(term), like(term), limit],
    ).catch(async () =>
      // Minimal column fallback for older schemas.
      query<any[]>(
        `SELECT party_id, customer_name, legal_name, gstin FROM customers_vendors
          WHERE (? = '' OR customer_name LIKE ? OR legal_name LIKE ? OR party_id LIKE ?)
          ORDER BY customer_name ASC LIMIT ?`,
        [term, like(term), like(term), like(term), limit],
      ),
    )
    return rows.map((r) => ({
      id: String(r.party_id),
      name: r.customer_name || r.legal_name || r.party_id,
      email: r.email || r.contact_email || null,
      mobile: r.mobile || r.phone || null,
      subtitle: [r.legal_name, r.gstin].filter(Boolean).join(" · ") || String(r.party_id),
    }))
  } catch (error) {
    console.error("[v0] searchVendors failed:", (error as Error).message)
    return []
  }
}

export async function getVendor(id: string): Promise<PartyOption | null> {
  try {
    const rows = await query<any[]>(
      `SELECT party_id, customer_name, legal_name, email, contact_email, mobile, phone, gstin
         FROM customers_vendors WHERE party_id = ? LIMIT 1`,
      [id],
    ).catch(async () =>
      query<any[]>(
        `SELECT party_id, customer_name, legal_name, gstin FROM customers_vendors WHERE party_id = ? LIMIT 1`,
        [id],
      ),
    )
    const r = rows[0]
    if (!r) return null
    return {
      id: String(r.party_id),
      name: r.customer_name || r.legal_name || r.party_id,
      email: r.email || r.contact_email || null,
      mobile: r.mobile || r.phone || null,
      subtitle: [r.legal_name, r.gstin].filter(Boolean).join(" · ") || null,
    }
  } catch {
    return null
  }
}

export async function searchParties(kind: PartyKind, term: string, limit = 20): Promise<PartyOption[]> {
  if (kind === "employee") return searchEmployees(term, limit)
  if (kind === "client") return searchClients(term, limit)
  return searchVendors(term, limit)
}

export async function getParty(kind: PartyKind, id: string): Promise<PartyOption | null> {
  if (kind === "employee") return getEmployee(id)
  if (kind === "client") return getClient(id)
  return getVendor(id)
}
