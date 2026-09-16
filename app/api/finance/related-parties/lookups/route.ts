import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"

/**
 * Phase 8 — Related Party master picker source.
 *
 * A related party is never a duplicate master: it is a link to an existing
 * customer, vendor, employee or group/associate. This endpoint feeds the
 * in-form picker with rows drawn from the authoritative masters:
 *   - customer / vendor / group  -> customers_vendors
 *   - employee / director        -> hr_employees
 *
 * Every row is normalized to { source_id, party_name, source_type, pan, gstin,
 * sub } so a single picker shape can autofill the related-party form.
 */

type Row = {
  source_id: string
  party_name: string
  source_type: string
  pan: string | null
  gstin: string | null
  sub: string | null
}

function like(search: string) {
  return `%${search.replace(/[%_]/g, (m) => "\\" + m)}%`
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function customersVendors(kind: "Customer" | "Vendor" | "Group / Associate", search: string): Promise<Row[]> {
  // customers_vendors.party_type is one of Customer / Vendor / Both. Customers
  // and vendors filter on that; a group / associate can be either, so it is not
  // constrained by party_type.
  const params: any[] = []
  const where: string[] = []
  if (kind === "Customer") where.push("party_type IN ('Customer','Both')")
  else if (kind === "Vendor") where.push("party_type IN ('Vendor','Both','Supplier')")
  if (search) {
    where.push("(party_name LIKE ? OR party_id LIKE ? OR pan LIKE ? OR gstin LIKE ?)")
    params.push(like(search), like(search), like(search), like(search))
  }
  const sql = `SELECT party_id, party_name, party_type, pan, gstin
               FROM customers_vendors
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY party_name LIMIT 25`
  const rows = await query<any[]>(sql, params)
  return (rows || []).map((r) => ({
    source_id: String(r.party_id ?? ""),
    party_name: String(r.party_name ?? ""),
    source_type: kind,
    pan: r.pan ?? null,
    gstin: r.gstin ?? null,
    sub: r.party_type ?? null,
  }))
}

async function employees(kind: "Employee" | "Director / Promoter", search: string): Promise<Row[]> {
  const params: any[] = []
  let where = ""
  if (search) {
    where = "WHERE (employee_name LIKE ? OR employee_id LIKE ? OR pan LIKE ?)"
    params.push(like(search), like(search), like(search))
  }
  // hr_employees is the authoritative employee master. PAN column names vary by
  // build, so read it defensively and fall back to null when absent.
  const sql = `SELECT employee_id, employee_name, designation, pan
               FROM hr_employees
               ${where}
               ORDER BY employee_name LIMIT 25`
  const rows = await safe(() => query<any[]>(sql, params), [])
  if (rows.length || !search) {
    // Retry without the pan column if it does not exist in this schema.
    const rows2 = rows.length
      ? rows
      : await safe(
          () =>
            query<any[]>(
              `SELECT employee_id, employee_name, designation FROM hr_employees ${
                search ? "WHERE (employee_name LIKE ? OR employee_id LIKE ?)" : ""
              } ORDER BY employee_name LIMIT 25`,
              search ? [like(search), like(search)] : [],
            ),
          [],
        )
    return rows2.map((r) => ({
      source_id: String(r.employee_id ?? ""),
      party_name: String(r.employee_name ?? ""),
      source_type: kind,
      pan: r.pan ?? null,
      gstin: null,
      sub: r.designation ?? null,
    }))
  }
  return []
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const source = (url.searchParams.get("source") || "").toLowerCase()
  const search = (url.searchParams.get("search") || "").trim()

  let rows: Row[] = []
  if (source === "customer") rows = await safe(() => customersVendors("Customer", search), [])
  else if (source === "vendor") rows = await safe(() => customersVendors("Vendor", search), [])
  else if (source === "group") rows = await safe(() => customersVendors("Group / Associate", search), [])
  else if (source === "employee" || source === "director") {
    const kind = source === "director" ? "Director / Promoter" : "Employee"
    rows = await safe(() => employees(kind, search), [])
  }

  return NextResponse.json({ rows })
}
