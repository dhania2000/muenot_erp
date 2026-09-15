import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export const runtime = "nodejs"

/**
 * Read-only master lookups for the manual journal dialog (Phases 33/34/35).
 *
 * Nothing here is a new master — every list resolves against the module that
 * already owns the data so the Journal reuses existing configuration:
 *   - parties   → Customers/Vendors + CRM Clients + HR Employees + Freelancers
 *                 (the distinct freelancers already invoiced), unified with the
 *                 source shown so an operator can tell a vendor from an employee.
 *   - projects  → Operations projects master.
 *   - costCentres → the distinct cost-centre values already used across
 *                 Expenses and Purchase Bills (free-text, so it doubles as a
 *                 suggestion list the operator can extend by typing).
 *
 * Every probe is guarded so a module absent in a given install is simply
 * skipped rather than failing the whole lookup.
 */
const LIMIT = 100

export async function GET(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const parties: Array<{ id: string; name: string; source: string }> = []
  const seen = new Set<string>()
  const push = (id: any, name: any, source: string) => {
    const pid = String(id ?? "").trim()
    if (!pid) return
    const key = `${source}:${pid}`
    if (seen.has(key)) return
    seen.add(key)
    parties.push({ id: pid, name: String(name ?? pid), source })
  }

  const safe = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch {
      // Module/table not present in this install — skip.
    }
  }

  await safe(async () => {
    const rows = (await query(
      `SELECT party_id, customer_name FROM customers_vendors
        WHERE status IS NULL OR status = 'Active' ORDER BY customer_name LIMIT ${LIMIT}`,
    )) as any[]
    for (const r of rows) push(r.party_id, r.customer_name, "Customer/Vendor")
  })

  await safe(async () => {
    const rows = (await query(
      `SELECT client_code, COALESCE(NULLIF(company_name,''), client_name) AS name
         FROM clients WHERE archived_at IS NULL ORDER BY name LIMIT ${LIMIT}`,
    )) as any[]
    for (const r of rows) push(r.client_code, r.name, "Customer")
  })

  await safe(async () => {
    const rows = (await query(
      `SELECT employee_id, employee_name FROM hr_employees
        WHERE employment_status IS NULL OR employment_status = 'Active'
        ORDER BY employee_name LIMIT ${LIMIT}`,
    )) as any[]
    for (const r of rows) push(r.employee_id, r.employee_name, "Employee")
  })

  await safe(async () => {
    const rows = (await query(
      `SELECT freelancer_id, MAX(freelancer_name) AS name FROM freelance_invoices
        WHERE freelancer_id IS NOT NULL AND freelancer_id <> ''
        GROUP BY freelancer_id ORDER BY name LIMIT ${LIMIT}`,
    )) as any[]
    for (const r of rows) push(r.freelancer_id, r.name, "Freelancer")
  })

  const projects: Array<{ id: string; name: string }> = []
  await safe(async () => {
    const rows = (await query(
      `SELECT project_id, project_name FROM operations_projects
        ORDER BY project_name LIMIT ${LIMIT}`,
    )) as any[]
    for (const r of rows) projects.push({ id: String(r.project_id), name: String(r.project_name ?? r.project_id) })
  })

  const costCentreSet = new Set<string>()
  const collectCostCentres = async (sql: string) => {
    await safe(async () => {
      const rows = (await query(sql)) as any[]
      for (const r of rows) {
        const cc = String(r.cost_centre ?? "").trim()
        if (cc) costCentreSet.add(cc)
      }
    })
  }
  await collectCostCentres(
    `SELECT DISTINCT cost_centre FROM expenses WHERE cost_centre IS NOT NULL AND cost_centre <> ''`,
  )
  await collectCostCentres(
    `SELECT DISTINCT cost_centre FROM purchase_bills WHERE cost_centre IS NOT NULL AND cost_centre <> ''`,
  )
  await collectCostCentres(
    `SELECT DISTINCT cost_centre FROM journal_entries WHERE cost_centre IS NOT NULL AND cost_centre <> ''`,
  )

  return NextResponse.json({
    parties,
    projects,
    costCentres: Array.from(costCentreSet).sort((a, b) => a.localeCompare(b)),
  })
}
