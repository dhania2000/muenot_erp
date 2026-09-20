import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { scopeWhereForModule, mergeScopeIntoWhere } from "@/lib/permission-enforce"
import type { SessionPayload } from "@/lib/auth"

export const runtime = "nodejs"

/**
 * SPEC 81 — Tenant-wide global search.
 *
 * A single read-only entry point that fans one query out across the primary
 * record tables every workspace module already owns and returns grouped hits.
 * It never introduces new storage: every group reads the same table the
 * matching module list page already reads, and every group is filtered through
 * the same `scopeWhereForModule` row-scope those list views use, so search can
 * never surface a record the viewer is not allowed to see. Tenant isolation is
 * applied by the shared DB layer exactly as it is for the module list routes.
 *
 * Any entity whose table/columns/permission key do not exist on a given install
 * is skipped silently (try/catch) rather than faked — honest coverage only.
 */

type SearchHit = {
  id: string | number
  title: string
  subtitle: string
  meta: string
}

type Group = {
  key: string
  label: string
  href: string
  results: SearchHit[]
}

type EntityDef = {
  key: string
  label: string
  table: string
  permissionKey: string
  href: string
  /** Columns matched with LIKE %q%. */
  textColumns: string[]
  /** Primary-key column (defaults to "id"). Also used for ordering. */
  idColumn?: string
  /** When true, an all-digit query also matches the numeric primary key. */
  matchId?: boolean
  title: (row: any) => string
  subtitle: (row: any) => string
  meta: (row: any) => string
}

const first = (...vals: any[]) => {
  for (const v of vals) if (v != null && String(v).trim() !== "") return String(v)
  return "—"
}

// The searchable spine of the ERP. Each entry maps a record type to the table
// the module already owns, the permission key that governs its row scope, and
// the list page a hit navigates to.
const entities: EntityDef[] = [
  {
    key: "employees",
    label: "Employees",
    table: "hr_employees",
    permissionKey: "hr.employees",
    href: "/modules/hr/employees",
    textColumns: ["name", "personal_email", "employee_code", "designation", "department"],
    matchId: true,
    title: (r) => first(r.name, r.employee_code, `Employee #${r.id}`),
    subtitle: (r) => first(r.designation, r.department),
    meta: (r) => first(r.status, r.employment_status, ""),
  },
  {
    key: "leads",
    label: "Leads",
    table: "sales_leads",
    permissionKey: "sales.leads",
    href: "/modules/sales/leads",
    textColumns: ["company_name", "contact_person", "email", "lead_code", "phone", "contact_number"],
    matchId: true,
    title: (r) => first(r.company_name, r.contact_person, `Lead #${r.id}`),
    subtitle: (r) => first(r.contact_person, r.email, r.lead_source),
    meta: (r) => first(r.status, ""),
  },
  {
    key: "companies",
    label: "Companies / Customers",
    table: "sales_companies",
    permissionKey: "sales.companies",
    href: "/modules/sales/companies",
    textColumns: ["company_name", "industry", "website", "contact_person", "email"],
    matchId: true,
    title: (r) => first(r.company_name, `Company #${r.id}`),
    subtitle: (r) => first(r.industry, r.website),
    meta: (r) => first(r.status, ""),
  },
  {
    key: "customers_vendors",
    label: "Customers & Vendors",
    table: "customers_vendors",
    permissionKey: "finance.customers_vendors",
    href: "/modules/finance/customers-vendors",
    textColumns: ["customer_name", "vendor_name", "party_name", "email", "gst_number", "phone"],
    matchId: true,
    title: (r) => first(r.customer_name, r.vendor_name, r.party_name, `Party #${r.id}`),
    subtitle: (r) => first(r.email, r.gst_number),
    meta: (r) => first(r.party_type, r.type, ""),
  },
  {
    key: "invoices",
    label: "Invoices",
    table: "sales_invoices",
    permissionKey: "finance.sales_invoices",
    href: "/modules/finance/sales-invoices",
    textColumns: ["invoice_id", "client_name", "customer_name"],
    matchId: true,
    title: (r) => first(r.invoice_id, `Invoice #${r.id}`),
    subtitle: (r) => first(r.client_name, r.customer_name),
    meta: (r) => first(r.status, ""),
  },
  {
    key: "expenses",
    label: "Expenses",
    table: "expenses",
    permissionKey: "finance.expenses",
    href: "/modules/finance/expenses",
    textColumns: ["expense_no", "expense_code", "description", "vendor_name", "category"],
    matchId: true,
    title: (r) => first(r.expense_no, r.expense_code, r.description, `Expense #${r.id}`),
    subtitle: (r) => first(r.vendor_name, r.category),
    meta: (r) => first(r.status, ""),
  },
  {
    key: "assets",
    label: "Fixed Assets",
    table: "fixed_assets",
    permissionKey: "finance.fixed_assets",
    href: "/modules/finance/fixed-assets",
    idColumn: "asset_id",
    textColumns: ["asset_name", "asset_category", "asset_type", "vendor", "location"],
    title: (r) => first(r.asset_name, r.asset_id, "Asset"),
    subtitle: (r) => first(r.asset_category, r.asset_type),
    meta: (r) => first(r.status, ""),
  },
  {
    key: "projects",
    label: "Projects",
    table: "operations_projects",
    permissionKey: "operations.projects",
    href: "/modules/operations/projects",
    textColumns: ["project_name", "client_name", "project_manager", "service_vertical"],
    matchId: true,
    title: (r) => first(r.project_name, `Project #${r.id}`),
    subtitle: (r) => first(r.client_name),
    meta: (r) => first(r.status, ""),
  },
  {
    key: "tasks",
    label: "Tasks",
    table: "operations_tasks",
    permissionKey: "operations.tasks",
    href: "/modules/operations/tasks",
    textColumns: ["task_title", "project_name", "client_name", "assigned_to"],
    matchId: true,
    title: (r) => first(r.task_title, `Task #${r.id}`),
    subtitle: (r) => first(r.project_name, r.client_name),
    meta: (r) => first(r.status, r.board_stage, ""),
  },
]

async function searchEntity(session: SessionPayload, def: EntityDef, q: string, like: string): Promise<Group | null> {
  const idCol = def.idColumn || "id"
  try {
    const scoped = await scopeWhereForModule(session, def.permissionKey, "view", def.table)
    const clauses: string[] = def.textColumns.map((c) => `${c} LIKE ?`)
    const params: any[] = def.textColumns.map(() => like)
    if (def.matchId && /^\d+$/.test(q)) {
      clauses.push(`${idCol} = ?`)
      params.push(Number(q))
    }
    const baseWhere = `WHERE (${clauses.join(" OR ")})`
    const { where, args } = mergeScopeIntoWhere(baseWhere, params, scoped)
    const rows = await query<any[]>(`SELECT * FROM ${def.table} ${where} ORDER BY ${idCol} DESC LIMIT 6`, args)
    if (!rows.length) return null
    return {
      key: def.key,
      label: def.label,
      href: def.href,
      results: rows.map((r) => ({
        id: r[idCol] ?? r.id,
        title: def.title(r),
        subtitle: def.subtitle(r),
        meta: def.meta(r),
      })),
    }
  } catch {
    // Table / column / permission key not present on this install — skip it
    // rather than surfacing an error or fabricated rows.
    return null
  }
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q = (new URL(request.url).searchParams.get("q") || "").trim()
  if (q.length < 2) return NextResponse.json({ query: q, total: 0, groups: [] as Group[] })

  const like = `%${q}%`
  try {
    const settled = await Promise.all(entities.map((def) => searchEntity(session, def, q, like)))
    const groups = settled.filter((g): g is Group => g !== null)
    const total = groups.reduce((sum, g) => sum + g.results.length, 0)
    return NextResponse.json({ query: q, total, groups })
  } catch (error) {
    console.log("[v0] global search failed:", (error as Error).message)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
