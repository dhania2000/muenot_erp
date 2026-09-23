import "server-only"
/**
 * Enterprise Dashboard Engine: widget registry + data resolvers.
 *
 * Every widget declares the permission `feature` slug required to see it (empty
 * string = always available). The catalog is filtered by the caller's feature
 * checker, and the data endpoint re-checks each requested widget before running
 * its resolver, so a user can never pull data from a widget they cannot access.
 *
 * Resolvers query the tenant-scoped data layer (`query`) — tenant isolation is
 * enforced by the per-request tenant context set in `getSession`. Each resolver
 * is defensive: a missing table/column resolves to an empty widget instead of
 * failing the whole dashboard (mirrors the existing module dashboard routes).
 */
import { query } from "@/lib/db"
import { getPersonalDashboard } from "@/lib/personal-dashboard"
import type {
  ChartKind,
  WidgetCatalogEntry,
  WidgetData,
  WidgetFilterKey,
  WidgetType,
} from "./types"

export type ResolvedFilters = {
  from: string | null
  to: string | null
  department: string | null
  modules: string[] | null
}

export type ResolveContext = {
  userId: number
  userName: string
  role: "admin" | "employee"
  filters: ResolvedFilters
  can: (feature: string) => boolean
}

type WidgetDefinition = WidgetCatalogEntry & {
  feature: string
  resolve: (ctx: ResolveContext) => Promise<WidgetData>
}

const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
})
const money = (n: unknown) => inr.format(Number(n ?? 0))
const num = (n: unknown) => Number(n ?? 0)

/** Build a date-range predicate for a column from the resolved filters. */
function dateWhere(col: string, f: ResolvedFilters): { sql: string; params: string[] } {
  const parts: string[] = []
  const params: string[] = []
  if (f.from) {
    parts.push(`${col} >= ?`)
    params.push(f.from)
  }
  if (f.to) {
    parts.push(`${col} <= ?`)
    params.push(f.to)
  }
  return { sql: parts.length ? parts.join(" AND ") : "1=1", params }
}

async function rows<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await query<T[]>(sql, params)) as T[]
}

// ---------------------------------------------------------------------------
// Widget definitions
// ---------------------------------------------------------------------------

const WIDGETS: WidgetDefinition[] = [
  // --- Personal (always available) -----------------------------------------
  {
    key: "personal.overview",
    title: "My work overview",
    description: "Your open to-dos, pending work, projects and meetings today.",
    module: "Personal",
    moduleSlug: "personal",
    type: "kpi",
    feature: "",
    filters: [],
    size: "lg",
    async resolve(ctx) {
      const data = await getPersonalDashboard(ctx.userId, ctx.userName)
      return {
        kind: "kpi",
        items: [
          { label: "Open to-dos", value: data.stats.openTodos },
          { label: "Pending work", value: data.stats.pendingWork, tone: data.stats.pendingWork > 0 ? "warning" : "default" },
          { label: "Active projects", value: data.stats.activeProjects },
          { label: "Meetings today", value: data.stats.meetingsToday },
        ],
      }
    },
  },

  // --- Finance --------------------------------------------------------------
  {
    key: "finance.kpis",
    title: "Finance KPIs",
    description: "Receivables, payables, expenses and bank balance.",
    module: "Finance",
    moduleSlug: "finance",
    type: "kpi",
    feature: "finance.view_dashboard",
    filters: [],
    size: "lg",
    async resolve() {
      const [r] = await rows(
        `SELECT
           COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'sales-invoices' AND status IN ('Pending','Ready','Overdue','Partially Paid')), 0) AS receivables,
           COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'purchase-bills' AND status <> 'Paid'), 0) AS payables,
           COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'expenses'), 0) AS expenses,
           COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'bank-cash'), 0) AS bank_balance`,
      )
      return {
        kind: "kpi",
        items: [
          { label: "Receivables", value: money(r?.receivables), tone: "warning" },
          { label: "Payables", value: money(r?.payables), tone: "critical" },
          { label: "Expenses", value: money(r?.expenses) },
          { label: "Bank balance", value: money(r?.bank_balance), tone: "positive" },
        ],
      }
    },
  },
  {
    key: "finance.invoice_status",
    title: "Invoices by status",
    description: "Count of sales invoices grouped by status.",
    module: "Finance",
    moduleSlug: "finance",
    type: "chart",
    chart: "bar",
    feature: "finance.view_dashboard",
    filters: [],
    size: "md",
    async resolve() {
      const data = await rows(
        `SELECT COALESCE(NULLIF(status,''),'Unknown') AS status, COUNT(*) AS count
         FROM finance_records WHERE module_key = 'sales-invoices'
         GROUP BY status ORDER BY count DESC`,
      )
      return {
        kind: "chart",
        chart: "bar",
        xKey: "status",
        series: [{ key: "count", label: "Invoices", color: CHART_COLORS[0] }],
        points: data.map((d) => ({ status: d.status, count: num(d.count) })),
      }
    },
  },
  {
    key: "finance.recent_transactions",
    title: "Recent transactions",
    description: "Latest bank transactions in the selected date range.",
    module: "Finance",
    moduleSlug: "finance",
    type: "table",
    feature: "finance.view_dashboard",
    filters: ["dateRange"],
    size: "lg",
    async resolve(ctx) {
      const d = dateWhere("record_date", ctx.filters)
      const data = await rows(
        `SELECT reference_no, record_date, party_name, debit, credit, reconciliation_status
         FROM finance_records
         WHERE module_key = 'bank-transactions' AND ${d.sql}
         ORDER BY record_date DESC, record_id DESC LIMIT 12`,
        d.params,
      )
      return {
        kind: "table",
        columns: [
          { key: "reference_no", label: "Reference" },
          { key: "record_date", label: "Date" },
          { key: "party_name", label: "Party" },
          { key: "debit", label: "Debit", align: "right" },
          { key: "credit", label: "Credit", align: "right" },
        ],
        rows: data.map((r) => ({
          reference_no: r.reference_no ?? "—",
          record_date: r.record_date ? String(r.record_date).slice(0, 10) : "—",
          party_name: r.party_name ?? "—",
          debit: r.debit ? money(r.debit) : "—",
          credit: r.credit ? money(r.credit) : "—",
        })),
      }
    },
  },

  // --- Sales ----------------------------------------------------------------
  {
    key: "sales.kpis",
    title: "Sales KPIs",
    description: "Lead pipeline health at a glance.",
    module: "Sales",
    moduleSlug: "sales",
    type: "kpi",
    feature: "sales.view_dashboard",
    filters: [],
    size: "lg",
    async resolve() {
      const [t] = await rows(
        `SELECT
           COUNT(*) AS total_leads,
           SUM(lead_status NOT IN ('Won','Lost')) AS open_count,
           SUM(lead_status = 'Won') AS won_count,
           SUM(lead_status = 'Lost') AS lost_count
         FROM sales_leads WHERE archived_at IS NULL`,
      )
      const won = num(t?.won_count)
      const lost = num(t?.lost_count)
      const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0
      return {
        kind: "kpi",
        items: [
          { label: "Total leads", value: num(t?.total_leads) },
          { label: "Open pipeline", value: num(t?.open_count) },
          { label: "Won", value: won, tone: "positive" },
          { label: "Win rate", value: `${winRate}%` },
        ],
      }
    },
  },
  {
    key: "sales.by_status",
    title: "Leads by status",
    description: "Open leads grouped by pipeline status.",
    module: "Sales",
    moduleSlug: "sales",
    type: "chart",
    chart: "bar",
    feature: "sales.view_dashboard",
    filters: [],
    size: "md",
    async resolve() {
      const data = await rows(
        `SELECT COALESCE(NULLIF(status,''),'Unknown') AS status, COUNT(*) AS count
         FROM sales_leads
         WHERE archived_at IS NULL AND lead_status NOT IN ('Won','Lost')
         GROUP BY status ORDER BY count DESC`,
      )
      return {
        kind: "chart",
        chart: "bar",
        xKey: "status",
        series: [{ key: "count", label: "Leads", color: CHART_COLORS[0] }],
        points: data.map((d) => ({ status: d.status, count: num(d.count) })),
      }
    },
  },
  {
    key: "sales.by_source",
    title: "Leads by source",
    description: "Where your leads originate.",
    module: "Sales",
    moduleSlug: "sales",
    type: "chart",
    chart: "pie",
    feature: "sales.view_dashboard",
    filters: [],
    size: "md",
    async resolve() {
      const data = await rows(
        `SELECT COALESCE(NULLIF(lead_source,''),'Unknown') AS source, COUNT(*) AS count
         FROM sales_leads GROUP BY lead_source ORDER BY count DESC LIMIT 8`,
      )
      return {
        kind: "chart",
        chart: "pie",
        xKey: "source",
        series: [{ key: "count", label: "Leads", color: CHART_COLORS[0] }],
        points: data.map((d, i) => ({ source: d.source, count: num(d.count), fill: CHART_COLORS[i % CHART_COLORS.length] })),
      }
    },
  },
  {
    key: "sales.upcoming_meetings",
    title: "Upcoming meetings",
    description: "Scheduled sales meetings in the selected date range.",
    module: "Sales",
    moduleSlug: "sales",
    type: "table",
    feature: "sales.view_dashboard",
    filters: ["dateRange"],
    size: "lg",
    async resolve(ctx) {
      const from = ctx.filters.from ?? null
      const parts = ["meeting_date >= COALESCE(?, CURDATE())"]
      const params: any[] = [from]
      if (ctx.filters.to) {
        parts.push("meeting_date <= ?")
        params.push(ctx.filters.to)
      }
      const data = await rows(
        `SELECT company_name, contact_person, meeting_date, meeting_time, meeting_type
         FROM sales_meetings WHERE ${parts.join(" AND ")}
         ORDER BY meeting_date ASC, meeting_time ASC LIMIT 12`,
        params,
      )
      return {
        kind: "table",
        columns: [
          { key: "meeting_date", label: "Date" },
          { key: "company_name", label: "Company" },
          { key: "contact_person", label: "Contact" },
          { key: "meeting_type", label: "Type" },
        ],
        rows: data.map((r) => ({
          meeting_date: r.meeting_date
            ? `${String(r.meeting_date).slice(0, 10)}${r.meeting_time ? " " + String(r.meeting_time).slice(0, 5) : ""}`
            : "—",
          company_name: r.company_name ?? "—",
          contact_person: r.contact_person ?? "—",
          meeting_type: r.meeting_type ?? "—",
        })),
      }
    },
  },

  // --- HR -------------------------------------------------------------------
  {
    key: "hr.headcount",
    title: "Headcount KPIs",
    description: "Employee headcount, attendance and pending leaves.",
    module: "HR",
    moduleSlug: "hr",
    type: "kpi",
    feature: "hr.view_dashboard",
    filters: ["department"],
    size: "lg",
    async resolve(ctx) {
      const dep = ctx.filters.department
      const depSql = dep ? "AND department = ?" : ""
      const [hc] = await rows(
        `SELECT COUNT(*) AS total, SUM(employment_status = 'Active') AS active
         FROM hr_employees WHERE 1=1 ${depSql}`,
        dep ? [dep] : [],
      )
      const [att] = await rows(
        `SELECT SUM(status = 'Present') AS present FROM hr_attendance WHERE work_date = CURDATE()`,
      )
      const [lv] = await rows(
        `SELECT SUM(status NOT LIKE '%Rejected%' AND status <> 'HR Approved') AS pending FROM hr_leave_requests`,
      )
      return {
        kind: "kpi",
        items: [
          { label: "Total employees", value: num(hc?.total) },
          { label: "Active", value: num(hc?.active), tone: "positive" },
          { label: "Present today", value: num(att?.present) },
          { label: "Pending leaves", value: num(lv?.pending), tone: num(lv?.pending) > 0 ? "warning" : "default" },
        ],
      }
    },
  },
  {
    key: "hr.by_department",
    title: "Headcount by department",
    description: "Employee distribution across departments.",
    module: "HR",
    moduleSlug: "hr",
    type: "chart",
    chart: "bar",
    feature: "hr.view_dashboard",
    filters: [],
    size: "md",
    async resolve() {
      const data = await rows(
        `SELECT COALESCE(NULLIF(department,''),'Unassigned') AS department, COUNT(*) AS count
         FROM hr_employees GROUP BY department ORDER BY count DESC LIMIT 8`,
      )
      return {
        kind: "chart",
        chart: "bar",
        xKey: "department",
        series: [{ key: "count", label: "Employees", color: CHART_COLORS[1] }],
        points: data.map((d) => ({ department: d.department, count: num(d.count) })),
      }
    },
  },
  {
    key: "hr.attendance_trend",
    title: "Attendance trend",
    description: "Present vs absent over the selected date range (default 7 days).",
    module: "HR",
    moduleSlug: "hr",
    type: "chart",
    chart: "line",
    feature: "hr.view_dashboard",
    filters: ["dateRange"],
    size: "md",
    async resolve(ctx) {
      const from = ctx.filters.from
      const to = ctx.filters.to
      const parts: string[] = []
      const params: any[] = []
      if (from) {
        parts.push("work_date >= ?")
        params.push(from)
      } else {
        parts.push("work_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)")
      }
      if (to) {
        parts.push("work_date <= ?")
        params.push(to)
      }
      const data = await rows(
        `SELECT work_date,
                SUM(status = 'Present') AS present,
                SUM(status = 'Absent') AS absent
         FROM hr_attendance WHERE ${parts.join(" AND ")}
         GROUP BY work_date ORDER BY work_date LIMIT 60`,
        params,
      )
      return {
        kind: "chart",
        chart: "line",
        xKey: "date",
        series: [
          { key: "present", label: "Present", color: CHART_COLORS[1] },
          { key: "absent", label: "Absent", color: CHART_COLORS[3] },
        ],
        points: data.map((d) => ({
          date: String(d.work_date).slice(5, 10),
          present: num(d.present),
          absent: num(d.absent),
        })),
      }
    },
  },
  {
    key: "hr.recent_joiners",
    title: "Recent joiners",
    description: "Employees who joined most recently.",
    module: "HR",
    moduleSlug: "hr",
    type: "table",
    feature: "hr.view_dashboard",
    filters: ["department"],
    size: "md",
    async resolve(ctx) {
      const dep = ctx.filters.department
      const depSql = dep ? "AND department = ?" : ""
      const data = await rows(
        `SELECT employee_name, department, designation, joining_date
         FROM hr_employees WHERE joining_date IS NOT NULL ${depSql}
         ORDER BY joining_date DESC LIMIT 8`,
        dep ? [dep] : [],
      )
      return {
        kind: "table",
        columns: [
          { key: "employee_name", label: "Employee" },
          { key: "department", label: "Department" },
          { key: "joining_date", label: "Joined" },
        ],
        rows: data.map((r) => ({
          employee_name: r.employee_name ?? "—",
          department: r.department ?? "—",
          joining_date: r.joining_date ? String(r.joining_date).slice(0, 10) : "—",
        })),
      }
    },
  },

  // --- Operations -----------------------------------------------------------
  {
    key: "operations.kpis",
    title: "Operations KPIs",
    description: "Resources, projects, issues and allocation health.",
    module: "Operations",
    moduleSlug: "operations",
    type: "kpi",
    feature: "operations.view_dashboard",
    filters: [],
    size: "lg",
    async resolve() {
      const [r] = await rows(
        `SELECT
           (SELECT COUNT(*) FROM operations_resources WHERE status = 'Active') AS active_resources,
           (SELECT COUNT(*) FROM operations_projects WHERE status = 'Active') AS active_projects,
           (SELECT COUNT(*) FROM operations_issues WHERE status IN ('Open','In Progress')) AS open_issues`,
      )
      const [over] = await rows(
        `SELECT COUNT(*) AS over_allocated FROM (
           SELECT resource_id, SUM(allocation_percent) AS total_percent
           FROM operations_allocations WHERE status = 'Active'
           GROUP BY resource_id HAVING total_percent > 100
         ) t`,
      )
      return {
        kind: "kpi",
        items: [
          { label: "Active resources", value: num(r?.active_resources) },
          { label: "Active projects", value: num(r?.active_projects) },
          { label: "Open issues", value: num(r?.open_issues), tone: num(r?.open_issues) > 0 ? "warning" : "default" },
          { label: "Over-allocated", value: num(over?.over_allocated), tone: num(over?.over_allocated) > 0 ? "critical" : "positive" },
        ],
      }
    },
  },
  {
    key: "operations.issue_status",
    title: "Issues by status",
    description: "Operations issues grouped by status.",
    module: "Operations",
    moduleSlug: "operations",
    type: "chart",
    chart: "bar",
    feature: "operations.view_dashboard",
    filters: [],
    size: "md",
    async resolve() {
      const data = await rows(
        `SELECT COALESCE(NULLIF(status,''),'Unknown') AS status, COUNT(*) AS count
         FROM operations_issues GROUP BY status ORDER BY count DESC`,
      )
      return {
        kind: "chart",
        chart: "bar",
        xKey: "status",
        series: [{ key: "count", label: "Issues", color: CHART_COLORS[3] }],
        points: data.map((d) => ({ status: d.status, count: num(d.count) })),
      }
    },
  },
  {
    key: "operations.resource_type",
    title: "Resources by type",
    description: "FTE vs freelancer / contractor split.",
    module: "Operations",
    moduleSlug: "operations",
    type: "chart",
    chart: "pie",
    feature: "operations.view_dashboard",
    filters: [],
    size: "md",
    async resolve() {
      const data = await rows(
        `SELECT COALESCE(NULLIF(resource_type,''),'Other') AS type, COUNT(*) AS count
         FROM operations_resources GROUP BY resource_type ORDER BY count DESC`,
      )
      return {
        kind: "chart",
        chart: "pie",
        xKey: "type",
        series: [{ key: "count", label: "Resources", color: CHART_COLORS[0] }],
        points: data.map((d, i) => ({ type: d.type, count: num(d.count), fill: CHART_COLORS[i % CHART_COLORS.length] })),
      }
    },
  },
]

const WIDGET_MAP = new Map(WIDGETS.map((w) => [w.key, w]))

/** Public catalog metadata (no resolvers) for a given permission checker. */
export function getCatalogForUser(can: (feature: string) => boolean): WidgetCatalogEntry[] {
  return WIDGETS.filter((w) => w.feature === "" || can(w.feature)).map((w) => ({
    key: w.key,
    title: w.title,
    description: w.description,
    module: w.module,
    moduleSlug: w.moduleSlug,
    type: w.type as WidgetType,
    chart: w.chart as ChartKind | undefined,
    filters: w.filters as WidgetFilterKey[],
    size: w.size,
  }))
}

/** The set of widget keys the user may access (for validation on save). */
export function getAllowedWidgetKeys(can: (feature: string) => boolean): Set<string> {
  return new Set(WIDGETS.filter((w) => w.feature === "" || can(w.feature)).map((w) => w.key))
}

/**
 * Resolve data for the requested widget keys. Silently drops unknown keys and
 * keys the user is not permitted to see, and turns any resolver failure into an
 * empty widget so one broken source never blanks the dashboard.
 */
export async function resolveWidgets(
  keys: string[],
  ctx: ResolveContext,
): Promise<Record<string, WidgetData>> {
  const unique = Array.from(new Set(keys))
  const out: Record<string, WidgetData> = {}
  await Promise.all(
    unique.map(async (key) => {
      const w = WIDGET_MAP.get(key)
      if (!w) return
      if (w.feature !== "" && !ctx.can(w.feature)) return
      try {
        out[key] = await w.resolve(ctx)
      } catch (err) {
        console.log(`[v0] dashboard widget "${key}" failed:`, (err as Error)?.message)
        out[key] = { kind: "empty", message: "Data unavailable" }
      }
    }),
  )
  return out
}
