import "server-only"
import { query } from "@/lib/db"

// Wraps a query so a missing/unreachable DB doesn't crash the page.
// Returns { ok:false } which pages render as a "connect your database" state.
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export async function safe<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Database error" }
  }
}

export type Lead = {
  id: number
  lead_code: string
  entry_date: string | null
  contact_person: string | null
  contact_number: string | null
  email: string | null
  designation: string | null
  lead_source: string | null
  company_name: string | null
  industry: string | null
  country: string | null
  assigned_to: string | null
  status: string | null
  follow_up_date: string | null
  next_auto_follow_up: string | null
  sla_gap_days: number | null
  health_score: number | null
  remarks: string | null
}

const LEAD_COLS =
  "id, lead_code, entry_date, contact_person, contact_number, email, designation, lead_source, company_name, industry, country, assigned_to, status, follow_up_date, next_auto_follow_up, sla_gap_days, health_score, remarks"

export async function listLeads(opts: { search?: string; status?: string; limit?: number } = {}) {
  const where: string[] = []
  const params: any[] = []
  if (opts.search) {
    where.push("(contact_person LIKE ? OR company_name LIKE ? OR email LIKE ? OR lead_code LIKE ?)")
    const q = `%${opts.search}%`
    params.push(q, q, q, q)
  }
  if (opts.status && opts.status !== "all") {
    where.push("status = ?")
    params.push(opts.status)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const limit = Math.min(opts.limit ?? 200, 500)
  return query<Lead>(
    `SELECT ${LEAD_COLS} FROM leads ${clause} ORDER BY entry_date DESC, id DESC LIMIT ${limit}`,
    params,
  )
}

export async function getLead(id: number) {
  const rows = await query<Lead>(`SELECT ${LEAD_COLS} FROM leads WHERE id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

export async function distinctLeadStatuses() {
  const rows = await query<{ status: string }>(
    "SELECT DISTINCT status FROM leads WHERE status IS NOT NULL AND status <> '' ORDER BY status",
  )
  return rows.map((r) => r.status)
}

// --- Dashboard aggregates -----------------------------------------
export async function salesDashboard() {
  const [[totals], byStatus, bySource, byIndustry, [deals], [pipeline], forecast] = await Promise.all([
    query<{ total: number; avg_health: number; overdue: number }>(
      "SELECT COUNT(*) AS total, ROUND(AVG(health_score)) AS avg_health, SUM(CASE WHEN sla_gap_days > 0 THEN 1 ELSE 0 END) AS overdue FROM leads",
    ),
    query<{ status: string; count: number }>(
      "SELECT COALESCE(status,'Unknown') AS status, COUNT(*) AS count FROM leads GROUP BY status ORDER BY count DESC LIMIT 8",
    ),
    query<{ source: string; count: number }>(
      "SELECT COALESCE(lead_source,'Unknown') AS source, COUNT(*) AS count FROM leads GROUP BY lead_source ORDER BY count DESC LIMIT 6",
    ),
    query<{ industry: string; count: number }>(
      "SELECT COALESCE(industry,'Unknown') AS industry, COUNT(*) AS count FROM leads GROUP BY industry ORDER BY count DESC LIMIT 6",
    ),
    query<{ won: number; lost: number }>(
      "SELECT SUM(outcome='won') AS won, SUM(outcome='lost') AS lost FROM deals",
    ),
    query<{ open_quotes: number; quote_value: number }>(
      "SELECT COUNT(*) AS open_quotes, COALESCE(SUM(total_amount),0) AS quote_value FROM quotations WHERE status NOT IN ('Accepted','Rejected')",
    ),
    query<{ quarter: string; expected: number }>(
      "SELECT quarter, SUM(expected_revenue) AS expected FROM revenue_forecast GROUP BY quarter ORDER BY quarter LIMIT 4",
    ),
  ])
  return { totals, byStatus, bySource, byIndustry, deals, pipeline, forecast }
}

// Generic paginated list for the simpler sales tables.
export async function listTable(table: string, orderBy: string, search?: { cols: string[]; term: string }, limit = 200) {
  const params: any[] = []
  let clause = ""
  if (search?.term) {
    clause = "WHERE " + search.cols.map((c) => `${c} LIKE ?`).join(" OR ")
    for (const _ of search.cols) params.push(`%${search.term}%`)
  }
  const lim = Math.min(limit, 500)
  return query<any>(`SELECT * FROM ${table} ${clause} ORDER BY ${orderBy} LIMIT ${lim}`, params)
}
