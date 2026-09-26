import "server-only"
import { query } from "@/lib/db"
import { getClassifiedExpiries } from "@/lib/expiry/service"
import type { ExpiryItem } from "@/lib/expiry/model"
import { scopeKeyOf, type RiskScope, type ScopeLevel } from "./scope"

export { scopeKeyOf }
export type { RiskScope, ScopeLevel }

/**
 * Spec43 (#196-199, #207-208) — Risk & compliance dashboard aggregator.
 *
 * READS existing subsystems only (approval authority, maker-checker, forensic
 * audit log, background jobs, finance payments / GST / TDS / bank recon, HR
 * documents / attendance / training, and the shared expiry engine for document
 * + contract expiry). It owns no source-of-truth data.
 *
 * Contracts the tests pin down:
 *   - Missing module: a source whose table/column is absent reports
 *     `available: false` with a "not installed" note; any other failure reports
 *     a generic note (SQL text is logged server-side, never returned).
 *   - Tenant scope: multi-tenant tables are ALWAYS filtered by the guard's
 *     tenant — failed-auth no longer includes tenant-less rows, which could
 *     belong to any tenant.
 *   - Aggregation scope: a source only contributes to a company / branch /
 *     department view when it can actually filter by that dimension. Otherwise
 *     it is `withheld` (count 0, no items) so a scope-restricted user never sees
 *     org-wide data through a source that can't be narrowed.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "ok"
export type RiskCategory = "operational" | "finance" | "hr" | "contracts"

export interface RiskItem {
  id: string
  label: string
  detail?: string | null
  severity: Severity
  amount?: number | null
  occurredAt?: string | null
  /** PII / counterparty fields; masked for non-owners and on export. */
  sensitive?: Record<string, string>
}

export interface SourceResult {
  key: string
  label: string
  category: RiskCategory
  available: boolean
  scopeApplied: boolean
  /** Source cannot filter by the requested dimension, so it is hidden. */
  withheld: boolean
  count: number
  severity: Severity
  asOf: string | null
  drillHref: string
  note?: string | null
  items: RiskItem[]
}

export interface RiskComplianceDashboard {
  tenantId: number
  scope: RiskScope
  scopeKey: string
  computedAt: string
  masked: boolean
  totals: {
    openItems: number
    critical: number
    high: number
    sourcesAvailable: number
    sourcesMissing: number
    sourcesWithheld: number
  }
  categories: Record<RiskCategory, { openItems: number; critical: number; sources: number }>
  sources: SourceResult[]
}

const ITEM_LIMIT = 25
const MASK = "•••• (masked)"

type Meta = Pick<SourceResult, "key" | "label" | "category" | "drillHref">
type Body = Omit<SourceResult, keyof Meta>
type Dims = Partial<Record<Exclude<ScopeLevel, "group">, string>>

class SourceMissing extends Error {}

/** Per-computation column cache (information_schema probe). */
class Columns {
  private cache = new Map<string, Promise<Set<string>>>()
  of(table: string): Promise<Set<string>> {
    let p = this.cache.get(table)
    if (!p) {
      p = query<any[]>(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table],
      ).then((rows) => new Set(rows.map((r) => String(r.c ?? r.COLUMN_NAME).toLowerCase())))
      this.cache.set(table, p)
    }
    return p
  }
  /** Columns of a table that must exist; throws SourceMissing otherwise. */
  async require(table: string, cols: string[] = []): Promise<Set<string>> {
    const set = await this.of(table)
    if (!set.size) throw new SourceMissing(table)
    const missing = cols.find((c) => !set.has(c))
    if (missing) throw new SourceMissing(`${table}.${missing}`)
    return set
  }
}

async function safe(meta: Meta, loader: () => Promise<Body>): Promise<SourceResult> {
  try {
    return { ...meta, ...(await loader()) }
  } catch (err) {
    const missing = err instanceof SourceMissing
    if (!missing) console.error(`[risk-compliance] source ${meta.key} failed:`, (err as Error)?.message)
    return {
      ...meta,
      available: false,
      scopeApplied: false,
      withheld: false,
      count: 0,
      severity: "ok",
      asOf: null,
      note: missing ? `Module not installed (${(err as Error).message})` : "Source query failed — see server logs",
      items: [],
    }
  }
}

function withheld(level: ScopeLevel): Body {
  return {
    available: true,
    scopeApplied: false,
    withheld: true,
    count: 0,
    severity: "ok",
    asOf: null,
    note: `Not broken down by ${level}; shown only in the group view.`,
    items: [],
  }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function iso(v: unknown): string | null {
  if (!v) return null
  const d = new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function dateOnly(v: unknown): string | null {
  const s = iso(v)
  return s ? s.slice(0, 10) : null
}

export function severityFromCount(count: number, critical = 10, high = 3): Severity {
  if (count <= 0) return "ok"
  if (count >= critical) return "critical"
  if (count >= high) return "high"
  return "medium"
}

/** Build the dimension predicate, or "withheld" when the source can't honour it. */
function dimFilter(scope: RiskScope, dims: Dims): { sql: string; params: string[] } | "withheld" {
  if (scope.level === "group") return { sql: "", params: [] }
  const col = dims[scope.level]
  if (!col || !scope.value) return "withheld"
  return { sql: ` AND ${col} = ?`, params: [scope.value] }
}

/** hr_employees dimension columns, resolved against the live schema. */
async function hrDims(cols: Columns, alias: string): Promise<Dims> {
  const e = await cols.of("hr_employees")
  const pick = (cands: string[]) => cands.find((c) => e.has(c))
  const dims: Dims = {}
  const company = pick(["legal_entity_id", "entity_id", "legal_entity", "entity"])
  const branch = pick(["branch_id", "branch", "branch_name", "work_location"])
  if (company) dims.company = `${alias}.${company}`
  if (branch) dims.branch = `${alias}.${branch}`
  if (e.has("department")) dims.department = `${alias}.department`
  return dims
}

interface SqlSource {
  from: string
  where: string
  params: unknown[]
  dims: Dims
  select: string
  orderBy: string
  asOfExpr: string
  thresholds: [number, number]
  mapRow: (r: any) => RiskItem
}

async function runSql(def: SqlSource, scope: RiskScope): Promise<Body> {
  const dim = dimFilter(scope, def.dims)
  if (dim === "withheld") return withheld(scope.level)
  const where = `WHERE ${def.where}${dim.sql}`
  const params = [...def.params, ...dim.params]
  const [rows, agg] = await Promise.all([
    query<any[]>(`SELECT ${def.select} FROM ${def.from} ${where} ORDER BY ${def.orderBy} LIMIT ${ITEM_LIMIT}`, params),
    query<any[]>(`SELECT COUNT(*) AS c, MAX(${def.asOfExpr}) AS m FROM ${def.from} ${where}`, params),
  ])
  const count = num(agg[0]?.c)
  return {
    available: true,
    scopeApplied: scope.level !== "group",
    withheld: false,
    count,
    severity: severityFromCount(count, ...def.thresholds),
    asOf: iso(agg[0]?.m),
    items: rows.map(def.mapRow),
  }
}

const DAY_MS = 86_400_000

// --- Operational ------------------------------------------------------------

function loadPendingApprovals(tenantId: number, scope: RiskScope, cols: Columns) {
  return safe(
    { key: "pending_approvals", label: "Pending approvals", category: "operational", drillHref: "/admin/approval-authority" },
    async () => {
      const c = await cols.require("approval_requests", ["tenant_id", "status"])
      const dims: Dims = {}
      if (c.has("legal_entity_id")) dims.company = "t.legal_entity_id"
      if (c.has("branch_id")) dims.branch = "t.branch_id"
      if (c.has("department")) dims.department = "t.department"
      return runSql(
        {
          from: "approval_requests t",
          where: "t.tenant_id = ? AND t.status = 'pending'",
          params: [tenantId],
          dims,
          select: "t.id, t.title, t.entity_ref, t.amount, t.department, t.created_at",
          orderBy: "t.created_at ASC",
          asOfExpr: "t.created_at",
          thresholds: [10, 3],
          mapRow: (r) => {
            const aged = r.created_at && Date.now() - new Date(r.created_at).getTime() > 7 * DAY_MS
            return {
              id: `approval:${r.id}`,
              label: r.title || r.entity_ref || `Approval #${r.id}`,
              detail: [r.department && `Dept: ${r.department}`, aged && "pending > 7 days"].filter(Boolean).join(" · ") || null,
              amount: r.amount != null ? num(r.amount) : null,
              occurredAt: iso(r.created_at),
              severity: aged ? "high" : "medium",
            }
          },
        },
        scope,
      )
    },
  )
}

function loadMakerChecker(tenantId: number, scope: RiskScope, cols: Columns) {
  return safe(
    { key: "maker_checker", label: "Maker-checker queue", category: "operational", drillHref: "/admin/governance" },
    async () => {
      await cols.require("maker_checker_changes", ["tenant_id", "status"])
      return runSql(
        {
          from: "maker_checker_changes t",
          where: "t.tenant_id = ? AND t.status = 'pending'",
          params: [tenantId],
          dims: {},
          select: "t.id, t.title, t.module_key, t.entity_ref, t.maker_name, t.created_at",
          orderBy: "t.created_at ASC",
          asOfExpr: "t.created_at",
          thresholds: [10, 3],
          mapRow: (r) => ({
            id: `mcc:${r.id}`,
            label: r.title || r.entity_ref || `${r.module_key} change`,
            detail: r.module_key ?? null,
            occurredAt: iso(r.created_at),
            severity: "medium",
            sensitive: r.maker_name ? { maker: String(r.maker_name) } : undefined,
          }),
        },
        scope,
      )
    },
  )
}

function loadFailedAuth(tenantId: number, scope: RiskScope, cols: Columns) {
  return safe(
    { key: "failed_auth", label: "Failed authentication (7d)", category: "operational", drillHref: "/admin/security/audit-log" },
    async () => {
      await cols.require("audit_log_entries", ["tenant_id", "result", "action"])
      return runSql(
        {
          from: "audit_log_entries t",
          // Strict tenant match: tenant-less failures can't be attributed and
          // would leak other tenants' login attempts.
          where: "t.tenant_id = ? AND t.result = 'failure' AND t.action LIKE 'auth.%' AND t.created_at >= (NOW() - INTERVAL 7 DAY)",
          params: [tenantId],
          dims: {},
          select: "t.id, t.action, t.actor_email, t.ip_address, t.created_at",
          orderBy: "t.created_at DESC",
          asOfExpr: "t.created_at",
          thresholds: [25, 8],
          mapRow: (r) => ({
            id: `auth:${r.id}`,
            label: r.action || "Auth failure",
            occurredAt: iso(r.created_at),
            severity: "high",
            sensitive: {
              ...(r.actor_email ? { email: String(r.actor_email) } : {}),
              ...(r.ip_address ? { ip: String(r.ip_address) } : {}),
            },
          }),
        },
        scope,
      )
    },
  )
}

function loadFailedJobs(tenantId: number, scope: RiskScope, cols: Columns) {
  return safe(
    { key: "jobs", label: "Failed background jobs", category: "operational", drillHref: "/admin/governance" },
    async () => {
      await cols.require("platform_background_jobs", ["tenant_id", "status"])
      return runSql(
        {
          from: "platform_background_jobs t",
          where: "t.tenant_id = ? AND t.status IN ('failed','dead_letter')",
          params: [tenantId],
          dims: {},
          select: "t.id, t.job_type, t.status, t.error_message, t.updated_at",
          orderBy: "t.updated_at DESC",
          asOfExpr: "t.updated_at",
          thresholds: [8, 2],
          mapRow: (r) => ({
            id: `job:${r.id}`,
            label: r.job_type || `Job #${r.id}`,
            detail: r.error_message ? String(r.error_message).slice(0, 120) : r.status,
            occurredAt: iso(r.updated_at),
            severity: r.status === "dead_letter" ? "critical" : "high",
          }),
        },
        scope,
      )
    },
  )
}

// --- Finance (legacy company books: no tenant_id; group view only) ----------

function loadPaymentExceptions(scope: RiskScope, cols: Columns) {
  return safe(
    { key: "payments", label: "Payment exceptions", category: "finance", drillHref: "/modules/finance/payments" },
    async () => {
      await cols.require("payments", ["status"])
      return runSql(
        {
          from: "payments t",
          where: "t.status = 'Reversed'",
          params: [],
          dims: {},
          select: "t.id, t.payment_id, t.party_name, t.amount, t.reversal_reason, t.payment_date",
          orderBy: "t.payment_date DESC",
          asOfExpr: "t.payment_date",
          thresholds: [10, 3],
          mapRow: (r) => ({
            id: `pay:${r.id}`,
            label: r.payment_id || `Payment #${r.id}`,
            detail: r.reversal_reason ? String(r.reversal_reason).slice(0, 120) : "Reversed",
            amount: r.amount != null ? num(r.amount) : null,
            occurredAt: iso(r.payment_date),
            severity: "high",
            sensitive: r.party_name ? { party: String(r.party_name) } : undefined,
          }),
        },
        scope,
      )
    },
  )
}

function loadGstCompliance(scope: RiskScope, cols: Columns) {
  return safe(
    { key: "gst_compliance", label: "GST filing status", category: "finance", drillHref: "/modules/finance/gst-filing" },
    async () => {
      const c = await cols.require("gst_filings", ["filing_status"])
      const due = c.has("due_date") ? "t.due_date" : "NULL"
      const asOf = c.has("updated_at") ? "t.updated_at" : due
      return runSql(
        {
          from: "gst_filings t",
          where: "COALESCE(t.filing_status,'') <> 'Filed'",
          params: [],
          dims: {},
          select: `t.id, t.return_type, t.return_period, t.filing_status, ${due} AS due_date, ${asOf} AS as_of`,
          orderBy: "t.return_period DESC, t.id DESC",
          asOfExpr: asOf,
          thresholds: [6, 2],
          mapRow: (r) => {
            const d = dateOnly(r.due_date)
            const overdue = !!d && d < new Date().toISOString().slice(0, 10)
            return {
              id: `gst:${r.id}`,
              label: `${r.return_type ?? "GST"} ${r.return_period ?? ""}`.trim(),
              detail: [r.filing_status || "Not filed", d && (overdue ? `overdue since ${d}` : `due ${d}`)].filter(Boolean).join(" · "),
              occurredAt: iso(r.as_of),
              severity: overdue ? "high" : "medium",
            }
          },
        },
        scope,
      )
    },
  )
}

function loadTdsCompliance(scope: RiskScope, cols: Columns) {
  return safe(
    { key: "tds_compliance", label: "TDS return status", category: "finance", drillHref: "/modules/finance/tds-filing" },
    async () => {
      const c = await cols.require("tds_filings")
      // The TDS compliance engine uses `status`; older rows only have `return_status`.
      const statusCol = c.has("status") ? "t.status" : c.has("return_status") ? "t.return_status" : null
      if (!statusCol) throw new SourceMissing("tds_filings.status")
      const period = ["period", "quarter"].find((x) => c.has(x))
      const fy = c.has("financial_year") ? "t.financial_year" : "NULL"
      const form = ["form_type", "return_type"].find((x) => c.has(x))
      const asOf = c.has("updated_at") ? "t.updated_at" : "NULL"
      return runSql(
        {
          from: "tds_filings t",
          where: `COALESCE(NULLIF(${statusCol},''),'Draft') NOT IN ('Filed','Cancelled')`,
          params: [],
          dims: {},
          select: `t.id, ${statusCol} AS status, ${period ? `t.${period}` : "NULL"} AS period, ${fy} AS fy, ${form ? `t.${form}` : "NULL"} AS form, ${asOf} AS as_of`,
          orderBy: "t.id DESC",
          asOfExpr: asOf,
          thresholds: [4, 2],
          mapRow: (r) => ({
            id: `tds:${r.id}`,
            label: [r.form ?? "TDS", r.period, r.fy].filter(Boolean).join(" "),
            detail: r.status || "Draft",
            occurredAt: iso(r.as_of),
            severity: ["Rejected", "Correction Required"].includes(r.status) ? "high" : "medium",
          }),
        },
        scope,
      )
    },
  )
}

function loadReconciliation(scope: RiskScope, cols: Columns) {
  return safe(
    { key: "reconciliation", label: "Bank reconciliation", category: "finance", drillHref: "/modules/finance/bank-transactions" },
    async () => {
      await cols.require("bank_transactions", ["reconciliation_status"])
      return runSql(
        {
          from: "bank_transactions t",
          where: "COALESCE(NULLIF(t.reconciliation_status,''),'Pending') <> 'Reconciled'",
          params: [],
          dims: {},
          select: "t.transaction_id, t.amount, t.transaction_date, t.reconciliation_status",
          orderBy: "t.transaction_date DESC",
          asOfExpr: "t.transaction_date",
          thresholds: [20, 5],
          mapRow: (r) => ({
            id: `bank:${r.transaction_id}`,
            label: `Txn ${r.transaction_id}`,
            detail: r.reconciliation_status || "Pending",
            amount: r.amount != null ? num(r.amount) : null,
            occurredAt: iso(r.transaction_date),
            severity: "medium",
          }),
        },
        scope,
      )
    },
  )
}

// --- HR ---------------------------------------------------------------------

function expirySeverity(it: ExpiryItem): Severity {
  if (it.status === "Expired") return it.daysUntil < -30 ? "critical" : "high"
  return it.escalation === "urgent" ? "high" : "medium"
}

function expiryBody(items: ExpiryItem[], thresholds: [number, number]): Body {
  const count = items.length
  return {
    available: true,
    scopeApplied: false,
    withheld: false,
    count,
    severity: severityFromCount(count, ...thresholds),
    asOf: new Date().toISOString(),
    items: items.slice(0, ITEM_LIMIT).map((it) => ({
      id: `exp:${it.sourceId}:${it.entityId}`,
      label: it.sourceLabel,
      detail: it.status === "Expired" ? `Expired ${-it.daysUntil}d ago (${it.expiryDate})` : `Expires in ${it.daysUntil}d (${it.expiryDate})`,
      occurredAt: iso(it.expiryDate),
      severity: expirySeverity(it),
      sensitive: {
        record: it.title,
        ...(it.subtitle ? { owner: it.subtitle } : {}),
        ...(it.documentNumber ? { number: it.documentNumber } : {}),
      },
    })),
  }
}

type ExpiryLoader = () => Promise<ExpiryItem[]>

function loadHrDocumentExpiry(scope: RiskScope, cols: Columns, expiries: ExpiryLoader) {
  return safe(
    { key: "hr_document_expiry", label: "Employee document expiry", category: "hr", drillHref: "/modules/operations/document-expiry" },
    async () => {
      await cols.require("hr_employee_documents")
      let items = (await expiries()).filter(
        (i) => (i.sourceId === "hr_employee_documents" || i.sourceId === "hr_passport_visa") && i.status !== "Valid" && i.status !== "None",
      )
      if (scope.level !== "group") {
        const dims = await hrDims(cols, "e")
        const col = dims[scope.level]
        if (!col) return withheld(scope.level)
        const ids = [...new Set(items.map((i) => i.ownerUserId).filter((x): x is number => x != null))]
        const inScope = new Set<number>()
        if (ids.length) {
          const rows = await query<any[]>(
            `SELECT e.user_id FROM hr_employees e WHERE ${col} = ? AND e.user_id IN (${ids.map(() => "?").join(",")})`,
            [scope.value, ...ids],
          )
          rows.forEach((r) => inScope.add(num(r.user_id)))
        }
        items = items.filter((i) => i.ownerUserId != null && inScope.has(i.ownerUserId))
      }
      return { ...expiryBody(items, [15, 4]), scopeApplied: scope.level !== "group" }
    },
  )
}

function loadHrDocumentVerification(scope: RiskScope, cols: Columns) {
  return safe(
    { key: "hr_document_verification", label: "Unverified employee documents", category: "hr", drillHref: "/modules/hr/employee-documents" },
    async () => {
      const c = await cols.require("hr_employee_documents", ["verified", "employee_id"])
      const dims = await hrDims(cols, "e")
      const asOf = c.has("updated_at") ? "d.updated_at" : "NULL"
      return runSql(
        {
          from: "hr_employee_documents d LEFT JOIN hr_employees e ON e.id = d.employee_id",
          where: `d.verified = 0${c.has("archived_at") ? " AND d.archived_at IS NULL" : ""}`,
          params: [],
          dims,
          select: `d.id, d.employee_id, d.document_type, e.full_name, ${asOf} AS as_of`,
          orderBy: "d.id DESC",
          asOfExpr: asOf,
          thresholds: [15, 4],
          mapRow: (r) => ({
            id: `hrdoc:${r.id}`,
            label: r.document_type || `Document #${r.id}`,
            detail: "Pending verification",
            occurredAt: iso(r.as_of),
            severity: "medium",
            sensitive: { employee: String(r.full_name || r.employee_id) },
          }),
        },
        scope,
      )
    },
  )
}

function loadHrAttendance(scope: RiskScope, cols: Columns) {
  return safe(
    { key: "hr_attendance", label: "Attendance regularisations", category: "hr", drillHref: "/modules/hr/attendance-regularisation" },
    async () => {
      const c = await cols.require("hr_attendance_regularisation", ["status"])
      const join = c.has("employee_id")
      const dims = join ? await hrDims(cols, "e") : {}
      if (c.has("department")) dims.department = "t.department"
      return runSql(
        {
          from: `hr_attendance_regularisation t${join ? " LEFT JOIN hr_employees e ON e.id = t.employee_id" : ""}`,
          where: "t.status = 'Pending'",
          params: [],
          dims,
          select: "t.id, t.request_id, t.employee_name, t.requested_at",
          orderBy: "t.requested_at ASC",
          asOfExpr: "t.requested_at",
          thresholds: [10, 3],
          mapRow: (r) => ({
            id: `att:${r.id}`,
            label: r.request_id || `Regularisation #${r.id}`,
            detail: "Pending review",
            occurredAt: iso(r.requested_at),
            severity: "low",
            sensitive: r.employee_name ? { employee: String(r.employee_name) } : undefined,
          }),
        },
        scope,
      )
    },
  )
}

function loadHrTraining(tenantId: number, scope: RiskScope, cols: Columns) {
  return safe(
    { key: "hr_training", label: "Overdue training", category: "hr", drillHref: "/modules/hr/training" },
    async () => {
      await cols.require("training_assignments", ["tenant_id", "status", "due_date"])
      const dims = await hrDims(cols, "e")
      return runSql(
        {
          from: "training_assignments t LEFT JOIN hr_employees e ON e.id = t.employee_id",
          where: "t.tenant_id = ? AND t.status <> 'completed' AND (t.status = 'overdue' OR (t.due_date IS NOT NULL AND t.due_date < CURDATE()))",
          params: [tenantId],
          dims,
          select: "t.id, t.employee_id, t.status, t.due_date",
          orderBy: "t.due_date ASC",
          asOfExpr: "t.due_date",
          thresholds: [25, 8],
          mapRow: (r) => ({
            id: `train:${r.id}`,
            label: `Assignment #${r.id}`,
            detail: `Due ${dateOnly(r.due_date) ?? "n/a"}`,
            occurredAt: iso(r.due_date),
            severity: "medium",
            sensitive: { employee: String(r.employee_id) },
          }),
        },
        scope,
      )
    },
  )
}

// --- Contracts --------------------------------------------------------------

function loadContractObligations(scope: RiskScope, cols: Columns, expiries: ExpiryLoader) {
  return safe(
    { key: "contract_obligations", label: "Contract expiry & renewals", category: "contracts", drillHref: "/modules/legal/contracts" },
    async () => {
      await cols.require("legal_generated_contracts")
      if (scope.level !== "group") return withheld(scope.level)
      const items = (await expiries()).filter(
        (i) => i.sourceId === "legal_generated_contracts" && i.status !== "Valid" && i.status !== "None",
      )
      return expiryBody(items, [10, 3])
    },
  )
}

/**
 * Compute the dashboard live. Never throws for a single broken source.
 * `now` is injectable for staleness tests.
 */
export async function computeRiskComplianceDashboard(
  tenantId: number,
  scope: RiskScope,
  now: Date = new Date(),
): Promise<RiskComplianceDashboard> {
  const cols = new Columns()
  // The expiry engine scans several tables — load it once for both consumers.
  let expiryPromise: Promise<ExpiryItem[]> | null = null
  const expiries: ExpiryLoader = () => (expiryPromise ??= getClassifiedExpiries(now))

  const sources = await Promise.all([
    loadPendingApprovals(tenantId, scope, cols),
    loadMakerChecker(tenantId, scope, cols),
    loadFailedAuth(tenantId, scope, cols),
    loadFailedJobs(tenantId, scope, cols),
    loadPaymentExceptions(scope, cols),
    loadGstCompliance(scope, cols),
    loadTdsCompliance(scope, cols),
    loadReconciliation(scope, cols),
    loadHrDocumentExpiry(scope, cols, expiries),
    loadHrDocumentVerification(scope, cols),
    loadHrAttendance(scope, cols),
    loadHrTraining(tenantId, scope, cols),
    loadContractObligations(scope, cols, expiries),
  ])

  return summarize(tenantId, scope, sources, now)
}

export function summarize(tenantId: number, scope: RiskScope, sources: SourceResult[], now = new Date()): RiskComplianceDashboard {
  const categories: RiskComplianceDashboard["categories"] = {
    operational: { openItems: 0, critical: 0, sources: 0 },
    finance: { openItems: 0, critical: 0, sources: 0 },
    hr: { openItems: 0, critical: 0, sources: 0 },
    contracts: { openItems: 0, critical: 0, sources: 0 },
  }
  const totals = { openItems: 0, critical: 0, high: 0, sourcesAvailable: 0, sourcesMissing: 0, sourcesWithheld: 0 }
  for (const s of sources) {
    const cat = categories[s.category]
    if (!s.available) totals.sourcesMissing += 1
    else if (s.withheld) totals.sourcesWithheld += 1
    else {
      totals.sourcesAvailable += 1
      cat.sources += 1
    }
    totals.openItems += s.count
    cat.openItems += s.count
    if (s.severity === "critical") {
      totals.critical += 1
      cat.critical += 1
    }
    if (s.severity === "high") totals.high += 1
  }
  return { tenantId, scope, scopeKey: scopeKeyOf(scope), computedAt: now.toISOString(), masked: false, totals, categories, sources }
}

/** Copy of the dashboard with every sensitive value masked (incl. inside label/detail). */
export function maskDashboard(dash: RiskComplianceDashboard): RiskComplianceDashboard {
  const scrub = (text: string | null | undefined, values: string[]) => {
    if (!text) return text ?? null
    let out = text
    for (const v of values) if (v && v.length >= 3) out = out.split(v).join(MASK)
    return out
  }
  return {
    ...dash,
    masked: true,
    sources: dash.sources.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (!it.sensitive || !Object.keys(it.sensitive).length) return it
        const values = Object.values(it.sensitive)
        const sensitive = Object.fromEntries(Object.keys(it.sensitive).map((k) => [k, MASK]))
        return { ...it, label: scrub(it.label, values) ?? "", detail: scrub(it.detail, values), sensitive }
      }),
    })),
  }
}

export function isStale(computedAt: string, maxAgeMs: number, now = Date.now()): boolean {
  const t = new Date(computedAt).getTime()
  if (Number.isNaN(t)) return true
  return now - t > maxAgeMs
}
