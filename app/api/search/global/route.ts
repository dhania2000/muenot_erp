import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query, tableColumns } from "@/lib/db"
import { scopeWhereForModule, mergeScopeIntoWhere } from "@/lib/permission-enforce"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
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
 * applied by the shared DB layer exactly as it is for the module list routes,
 * plus an explicit tenant predicate on the one genuinely per-row multi-tenant
 * source (file_objects — see searchDocuments).
 *
 * Robustness: each entity is COLUMN-ADAPTIVE. Because the production database
 * can lag the app's expected schema, we look up the columns that actually exist
 * (information_schema, cached) and only match on those — so a single renamed or
 * missing column can never make MySQL reject the statement and silently drop an
 * entire entity from search. An entity with no usable text column, or whose
 * table does not exist, is skipped rather than faked.
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
  /** Candidate columns matched with LIKE %q%. Only the ones that exist are used. */
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
// the list page a hit navigates to. Column names are validated against the live
// schema at query time (see searchEntity), so the lists below can safely enumerate
// every plausible match column without risking a hard failure on older installs.
const entities: EntityDef[] = [
  {
    key: "employees",
    label: "Employees",
    table: "hr_employees",
    permissionKey: "hr.employees",
    href: "/modules/hr/employees",
    textColumns: ["employee_name", "employee_id", "personal_email", "mobile", "department"],
    matchId: true,
    title: (r) => first(r.employee_name, r.employee_id, `Employee #${r.id}`),
    subtitle: (r) => first(r.department, r.personal_email),
    meta: (r) => first(r.employment_status, r.document_status, ""),
  },
  {
    key: "leads",
    label: "Leads",
    table: "sales_leads",
    permissionKey: "sales.leads",
    href: "/modules/sales/leads",
    textColumns: ["company_name", "contact_person", "email", "company_email", "lead_code", "contact_number"],
    matchId: true,
    title: (r) => first(r.company_name, r.contact_person, `Lead #${r.id}`),
    subtitle: (r) => first(r.contact_person, r.email, r.lead_source),
    meta: (r) => first(r.status, r.lead_status, ""),
  },
  {
    key: "companies",
    label: "Companies / Customers",
    table: "sales_companies",
    permissionKey: "sales.companies",
    href: "/modules/sales/companies",
    textColumns: ["company_name", "industry", "website", "company_email", "company_code"],
    matchId: true,
    title: (r) => first(r.company_name, `Company #${r.id}`),
    subtitle: (r) => first(r.industry, r.website),
    meta: (r) => first(r.status, r.company_type, ""),
  },
  {
    key: "customers_vendors",
    label: "Customers & Vendors",
    table: "customers_vendors",
    permissionKey: "finance.customers_vendors",
    href: "/modules/finance/customers-vendors",
    textColumns: ["customer_name", "legal_name", "contact_person", "official_email", "invoice_email", "gstin", "pan", "mobile"],
    matchId: true,
    title: (r) => first(r.customer_name, r.legal_name, `Party #${r.id}`),
    subtitle: (r) => first(r.official_email, r.gstin, r.contact_person),
    meta: (r) => first(r.party_type, r.status, ""),
  },
  {
    key: "invoices",
    label: "Invoices",
    table: "sales_invoices",
    permissionKey: "finance.sales_invoices",
    href: "/modules/finance/sales-invoices",
    textColumns: ["invoice_id", "client_name", "project_name"],
    matchId: true,
    title: (r) => first(r.invoice_id, `Invoice #${r.id}`),
    subtitle: (r) => first(r.client_name, r.project_name),
    meta: (r) => first(r.payment_status, r.invoice_status, ""),
  },
  {
    key: "expenses",
    label: "Expenses",
    table: "expenses",
    permissionKey: "finance.expenses",
    href: "/modules/finance/expenses",
    textColumns: ["expense_id", "description", "party_name", "expense_category", "expense_head", "project_name"],
    matchId: true,
    title: (r) => first(r.expense_id, r.description, `Expense #${r.id}`),
    subtitle: (r) => first(r.party_name, r.expense_category, r.expense_head),
    meta: (r) => first(r.approval_status, r.reimbursement_status, ""),
  },
  {
    key: "assets",
    label: "Fixed Assets",
    table: "fixed_assets",
    permissionKey: "finance.fixed_assets",
    href: "/modules/finance/fixed-assets",
    idColumn: "asset_id",
    textColumns: ["asset_name", "asset_category", "location", "custodian"],
    title: (r) => first(r.asset_name, r.asset_id, "Asset"),
    subtitle: (r) => first(r.asset_category, r.location),
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
  {
    key: "deals",
    label: "Deals / Quotations",
    table: "sales_quotations",
    permissionKey: "sales.quotations",
    href: "/modules/sales/quotations",
    textColumns: ["quote_code", "company_name", "contact_person", "opportunity_name"],
    matchId: true,
    title: (r) => first(r.opportunity_name, r.company_name, r.quote_code, `Deal #${r.id}`),
    subtitle: (r) => first(r.company_name, r.contact_person),
    meta: (r) => first(r.status, ""),
  },
  {
    key: "reports",
    label: "Reports",
    table: "finance_report_runs",
    permissionKey: "finance.reports",
    href: "/modules/finance/reports",
    textColumns: ["report_label", "report_key", "period_label", "user_name"],
    matchId: true,
    title: (r) => first(r.report_label, r.report_key, `Report #${r.id}`),
    subtitle: (r) => first(r.period_label, r.user_name),
    meta: (r) => first(r.format, ""),
  },
]

async function searchEntity(session: SessionPayload, def: EntityDef, q: string, like: string): Promise<Group | null> {
  try {
    // Column-adaptive: only match on columns that actually exist on this install.
    const cols = await tableColumns(def.table)
    if (cols.size === 0) return null // table absent -> skip honestly
    const idCol = def.idColumn && cols.has(def.idColumn) ? def.idColumn : "id"
    const usableText = def.textColumns.filter((c) => cols.has(c))

    const clauses: string[] = usableText.map((c) => `\`${c}\` LIKE ?`)
    const params: any[] = usableText.map(() => like)
    if (def.matchId && cols.has(idCol) && /^\d+$/.test(q)) {
      clauses.push(`\`${idCol}\` = ?`)
      params.push(Number(q))
    }
    if (clauses.length === 0) return null // nothing searchable on this install

    const scoped = await scopeWhereForModule(session, def.permissionKey, "view", def.table)
    const baseWhere = `WHERE (${clauses.join(" OR ")})`
    const { where, args } = mergeScopeIntoWhere(baseWhere, params, scoped)
    const orderCol = cols.has(idCol) ? idCol : "id"
    const rows = await query<any[]>(
      `SELECT * FROM \`${def.table}\` ${where} ORDER BY \`${orderCol}\` DESC LIMIT 6`,
      args,
    )
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

/**
 * Documents live in the unified, genuinely per-row multi-tenant `file_objects`
 * store (SPEC 32) rather than in a permission-catalog module, so they get their
 * own scoped query instead of going through `scopeWhereForModule`:
 *   - MANDATORY tenant predicate (tenant_id = the verified session tenant) so a
 *     viewer can never see another tenant's files. This is the fix for the
 *     otherwise-missing isolation on this table (the tenant guard runs in
 *     report-only mode by default and would not block a cross-tenant read).
 *   - Only current, non-deleted, successfully-uploaded objects are searchable.
 *   - Non-admins are limited to files they own (owner_id / created_by), matching
 *     the admin-only Storage browser's access model — search never widens access.
 */
async function searchDocuments(session: SessionPayload, like: string): Promise<Group | null> {
  const tenantId = session.tenantId ?? currentTenantIdOrNull()
  if (tenantId == null) return null // no resolved tenant -> never search across tenants
  try {
    const cols = await tableColumns("file_objects")
    if (cols.size === 0) return null
    const textCandidates = ["filename", "module", "entity_type"].filter((c) => cols.has(c))
    if (textCandidates.length === 0) return null

    const clauses: string[] = [`tenant_id = ?`]
    const args: any[] = [tenantId]
    if (cols.has("deleted_at")) clauses.push(`deleted_at IS NULL`)
    if (cols.has("is_current")) clauses.push(`is_current = 1`)
    if (cols.has("upload_status")) clauses.push(`upload_status = 'uploaded'`)

    // Non-admins only see their own files.
    if (session.role !== "admin") {
      const ownerCols: string[] = []
      if (cols.has("owner_id")) ownerCols.push("owner_id = ?")
      if (cols.has("created_by")) ownerCols.push("created_by = ?")
      if (ownerCols.length === 0) return null // cannot establish ownership -> deny
      clauses.push(`(${ownerCols.join(" OR ")})`)
      for (const _ of ownerCols) args.push(session.userId)
    }

    const textOr = textCandidates.map((c) => `\`${c}\` LIKE ?`).join(" OR ")
    clauses.push(`(${textOr})`)
    for (const _ of textCandidates) args.push(like)

    const rows = await query<any[]>(
      `SELECT * FROM file_objects WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT 6`,
      args,
    )
    if (!rows.length) return null
    return {
      key: "documents",
      label: "Documents",
      href: "/admin/storage/files",
      results: rows.map((r) => ({
        id: r.id,
        title: first(r.filename, `File #${r.id}`),
        subtitle: first(r.module, r.entity_type),
        meta: first(r.classification, ""),
      })),
    }
  } catch {
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
    const settled = await Promise.all([
      ...entities.map((def) => searchEntity(session, def, q, like)),
      searchDocuments(session, like),
    ])
    const groups = settled.filter((g): g is Group => g !== null)
    const total = groups.reduce((sum, g) => sum + g.results.length, 0)
    return NextResponse.json({ query: q, total, groups })
  } catch (error) {
    console.log("[v0] global search failed:", (error as Error).message)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
