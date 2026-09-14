import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

/**
 * Read-only master lookups for the Expense form (Phases 4–10). Each `type`
 * resolves against the authoritative owning module's table so nothing is
 * duplicated: employees from HR, vendors + bank/cash + COA from Finance,
 * projects from Operations. Every response is `{ rows }` with a normalized id /
 * name column pair the generic form picker understands. Bank/cash and expense
 * heads are filtered to active/expense accounts so an inactive account can
 * never be picked (Phase 10). Session-gated like the rest of the module API.
 */

const LIMIT = 25

/** Keep only the whitelisted keys that actually exist on the row. */
function project(row: Record<string, any>, keys: string[]) {
  const out: Record<string, any> = {}
  for (const k of keys) if (k in row) out[k] = row[k]
  return out
}

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const p = req.nextUrl.searchParams
  const type = String(p.get("type") || "")
  const search = String(p.get("search") || "").trim()
  const like = `%${search}%`

  try {
    if (type === "employee") {
      const rows = (await query(
        `SELECT employee_id, employee_name, department, designation, employment_type,
                official_email, personal_email, mobile, reporting_manager
           FROM hr_employees
          WHERE (? = '' OR employee_name LIKE ? OR employee_id LIKE ? OR department LIKE ?)
          ORDER BY employee_name LIMIT ${LIMIT}`,
        [search, like, like, like],
      )) as any[]
      return NextResponse.json({ rows })
    }

    if (type === "vendor") {
      const rows = (await query(
        `SELECT * FROM customers_vendors
          WHERE (? = '' OR customer_name LIKE ? OR party_id LIKE ? OR gstin LIKE ? OR pan LIKE ?)
          ORDER BY customer_name LIMIT ${LIMIT}`,
        [search, like, like, like, like],
      )) as any[]
      const keys = [
        "party_id", "customer_name", "legal_name", "gstin", "gst_verification_status",
        "gst_registration_type", "pan", "tds_applicable", "tds_section", "tds_rate",
        "state", "state_code", "pin_code", "postal_code", "payment_terms_days", "currency",
      ]
      return NextResponse.json({ rows: rows.map((r) => project(r, keys)) })
    }

    if (type === "project") {
      const rows = (await query(
        `SELECT project_id, project_name, client_name, status
           FROM operations_projects
          WHERE (? = '' OR project_name LIKE ? OR client_name LIKE ?)
          ORDER BY project_name LIMIT ${LIMIT}`,
        [search, like, like],
      )) as any[]
      return NextResponse.json({
        rows: rows.map((r) => ({ ...r, project_id: String(r.project_id) })),
      })
    }

    if (type === "account") {
      // Expense-head Chart of Accounts entries only, active ones (Phase 9).
      const rows = (await query(
        `SELECT account_id, account_code, account_name, account_group
           FROM chart_of_accounts
          WHERE account_group = 'Expense'
            AND (active_status IS NULL OR active_status = 'Active')
            AND (? = '' OR account_name LIKE ? OR account_code LIKE ?)
          ORDER BY account_name LIMIT ${LIMIT}`,
        [search, like, like],
      )) as any[]
      return NextResponse.json({ rows })
    }

    if (type === "coa") {
      // Any active Chart of Accounts head (used as the Bank Transaction account
      // head — the contra side of the bank/cash movement). Never lets a random
      // account name be typed by hand: the posting keys off account_id.
      const rows = (await query(
        `SELECT account_id, account_code, account_name, account_group, nature
           FROM chart_of_accounts
          WHERE (active_status IS NULL OR active_status = 'Active')
            AND (? = '' OR account_name LIKE ? OR account_code LIKE ? OR account_group LIKE ?)
          ORDER BY account_group, account_name LIMIT ${LIMIT}`,
        [search, like, like, like],
      )) as any[]
      return NextResponse.json({ rows })
    }

    if (type === "client") {
      // Customer parties resolved from the Clients master (Phase 4 — smart party
      // selection). `client_code` is the stable business id used as party_id.
      const rows = (await query(
        `SELECT client_code, client_name, company_name, gst_number, email, mobile, state
           FROM clients
          WHERE (? = '' OR client_name LIKE ? OR company_name LIKE ? OR client_code LIKE ? OR gst_number LIKE ?)
          ORDER BY client_name LIMIT ${LIMIT}`,
        [search, like, like, like, like],
      )) as any[]
      return NextResponse.json({
        rows: rows.map((r) => ({ ...r, client_code: String(r.client_code ?? "") })),
      })
    }

    if (type === "bank") {
      // Only active Bank/Cash accounts are selectable (Phase 10).
      const rows = (await query(
        `SELECT finance_account_id, account_name, account_type, bank_name, active_status
           FROM finance_accounts
          WHERE (active_status IS NULL OR active_status = 'Active')
            AND (? = '' OR account_name LIKE ? OR bank_name LIKE ? OR finance_account_id LIKE ?)
          ORDER BY account_name LIMIT ${LIMIT}`,
        [search, like, like, like],
      )) as any[]
      return NextResponse.json({ rows })
    }

    return NextResponse.json({ error: "Unknown lookup type" }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || "Lookup failed" }, { status: 500 })
  }
}
