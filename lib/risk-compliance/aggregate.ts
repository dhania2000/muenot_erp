import "server-only"
import { query } from "@/lib/db"

/**
 * Spec43 (#196-199, #207-208) — Risk & compliance dashboard aggregator.
 *
 * This module READS from existing subsystems and rolls them into a single
 * risk/compliance view. It creates no source-of-truth data. Every source is
 * queried defensively (see `safe`): a missing table, dropped column, or query
 * error degrades that ONE source to `available: false` instead of failing the
 * whole dashboard — this is the "missing source module" contract the tests
 * exercise.
 *
 * Tenant scope: multi-tenant tables carry a `tenant_id` and are always filtered
 * by the acting tenant. Some legacy finance/HR tables are the company's own
 * single-tenant books (no `tenant_id` column) and are reported company-wide;
 * those declare `tenantColumn: null`. The route ALWAYS resolves the tenant from
 * the session guard, never from client input.
 *
 * Aggregation dimensions (group / company / branch / department) are applied per
 * source where the underlying column exists; a source that cannot honour the
 * requested dimension reports `scopeApplied: false` rather than erroring, so the
 * aggregate stays honest about partial coverage.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "ok"
export type RiskCategory = "operational" | "finance" | "hr"
export type ScopeLevel = "group" | "company" | "branch" | "department"

export interface RiskScope {
  level: ScopeLevel
  /** Dimension value, e.g. a department name or a legal-entity id. */
  value?: string | null
}

export interface RiskItem {
  id: string
  label: string
  detail?: string | null
  severity: Severity
  amount?: number | null
  occurredAt?: string | null
  /**
   * Field values that must be masked on export unless the caller is explicitly
   * authorized to see them (e.g. counterparties, emails, PII).
   */
  sensitive?: Record<string, string>
}

export interface SourceResult {
  key: string
  label: string
  category: RiskCategory
  /** False when the underlying table/module is absent — surfaced, not fatal. */
  available: boolean
  /** True when the requested scope dimension was applied to this source. */
  scopeApplied: boolean
  /** Number of open risk/compliance items in scope. */
  count: number
  severity: Severity
  /** Newest underlying record timestamp (ISO) — drives per-source staleness. */
  asOf: string | null
  /** Deep link into the owning module for drill-down. */
  drillHref: string
  /** Human note when the source is unavailable. */
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
  }
  categories: Record<RiskCategory, { openItems: number; critical: number; sources: number }>
  sources: SourceResult[]
}

const ITEM_LIMIT = 25

/** Canonical cache/scope key for a scope selection. */
export function scopeKeyOf(scope: RiskScope): string {
  if (scope.level === "group") return "group"
  return `${scope.level}:${(scope.value ?? "").toString().slice(0, 150)}`
}

/**
 * Run a source loader, converting ANY failure (missing table, bad column, DB
 * error) into an unavailable source. This is the missing-source contract.
 */
async function safe(
  meta: Pick<SourceResult, "key" | "label" | "category" | "drillHref">,
  loader: () => Promise<Omit<SourceResult, "key" | "label" | "category" | "drillHref">>,
): Promise<SourceResult> {
  try {
    const partial = await loader()
    return { ...meta, ...partial }
  } catch (err) {
    return {
      ...meta,
      available: false,
      scopeApplied: false,
      count: 0,
      severity: "ok",
      asOf: null,
      note: `Source unavailable: ${(err as Error)?.message?.slice(0, 140) || "not installed"}`,
      items: [],
    }
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

function severityFromCount(count: number, critical = 10, high = 3): Severity {
  if (count <= 0) return "ok"
  if (count >= critical) return "critical"
  if (count >= high) return "high"
  return "medium"
}

/**
 * Department scope predicate for a source that has a department column.
 * Returns the SQL fragment + params, or null when no dept filter applies.
 */
function deptFilter(scope: RiskScope, column: string): { sql: string; params: string[] } | null {
  if (scope.level === "department" && scope.value) {
    return { sql: ` AND ${column} = ?`, params: [scope.value] }
  }
  return null
}

// --- Operational sources ----------------------------------------------------

async function loadPendingApprovals(tenantId: number, scope: RiskScope) {
  return safe(
    { key: "pending_approvals", label: "Pending approvals", category: "operational", drillHref: "/admin/governance" },
    async () => {
      const dept = deptFilter(scope, "department")
      const rows = await query<any[]>(
        `SELECT id, title, entity_ref, amount, department, created_at
           FROM approval_requests
          WHERE tenant_id = ? AND status = 'pending'${dept?.sql ?? ""}
          ORDER BY created_at ASC LIMIT ${ITEM_LIMIT}`,
        [tenantId, ...(dept?.params ?? [])],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(created_at) m FROM approval_requests
          WHERE tenant_id = ? AND status = 'pending'${dept?.sql ?? ""}`,
        [tenantId, ...(dept?.params ?? [])],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: !!dept || scope.level !== "department",
        count,
        severity: severityFromCount(count),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `approval:${r.id}`,
          label: r.title || r.entity_ref || `Approval #${r.id}`,
          detail: r.department ? `Dept: ${r.department}` : null,
          amount: r.amount != null ? num(r.amount) : null,
          occurredAt: iso(r.created_at),
          severity: "medium" as Severity,
        })),
      }
    },
  )
}

async function loadMakerChecker(tenantId: number, scope: RiskScope) {
  return safe(
    { key: "maker_checker", label: "Maker-checker queue", category: "operational", drillHref: "/admin/governance" },
    async () => {
      const rows = await query<any[]>(
        `SELECT id, title, module_key, entity_ref, maker_name, status, created_at
           FROM maker_checker_changes
          WHERE tenant_id = ? AND status = 'pending'
          ORDER BY created_at ASC LIMIT ${ITEM_LIMIT}`,
        [tenantId],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(created_at) m FROM maker_checker_changes WHERE tenant_id = ? AND status = 'pending'`,
        [tenantId],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level !== "department",
        count,
        severity: severityFromCount(count),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `mcc:${r.id}`,
          label: r.title || r.entity_ref || `${r.module_key} change`,
          detail: r.maker_name ? `By ${r.maker_name}` : null,
          occurredAt: iso(r.created_at),
          severity: "medium" as Severity,
          sensitive: r.maker_name ? { maker: r.maker_name } : undefined,
        })),
      }
    },
  )
}

async function loadFailedAuth(tenantId: number, scope: RiskScope) {
  return safe(
    { key: "failed_auth", label: "Failed authentication", category: "operational", drillHref: "/admin/security/audit-log" },
    async () => {
      const rows = await query<any[]>(
        `SELECT id, action, subject_email, ip_address, created_at
           FROM security_audit_events
          WHERE (tenant_id = ? OR tenant_id IS NULL)
            AND outcome = 'failure' AND category = 'auth'
            AND created_at >= (NOW() - INTERVAL 7 DAY)
          ORDER BY created_at DESC LIMIT ${ITEM_LIMIT}`,
        [tenantId],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(created_at) m FROM security_audit_events
          WHERE (tenant_id = ? OR tenant_id IS NULL)
            AND outcome = 'failure' AND category = 'auth'
            AND created_at >= (NOW() - INTERVAL 7 DAY)`,
        [tenantId],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level !== "department",
        count,
        severity: severityFromCount(count, 25, 8),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `auth:${r.id}`,
          label: r.action || "Auth failure",
          detail: r.subject_email ? `User ${r.subject_email}` : null,
          occurredAt: iso(r.created_at),
          severity: "high" as Severity,
          sensitive: {
            ...(r.subject_email ? { email: r.subject_email } : {}),
            ...(r.ip_address ? { ip: r.ip_address } : {}),
          },
        })),
      }
    },
  )
}

async function loadFailedJobs(tenantId: number, scope: RiskScope) {
  return safe(
    { key: "jobs", label: "Failed background jobs", category: "operational", drillHref: "/admin/governance" },
    async () => {
      const rows = await query<any[]>(
        `SELECT id, job_type, status, last_error, updated_at
           FROM platform_background_jobs
          WHERE tenant_id = ? AND status IN ('failed','dead')
          ORDER BY updated_at DESC LIMIT ${ITEM_LIMIT}`,
        [tenantId],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(updated_at) m FROM platform_background_jobs
          WHERE tenant_id = ? AND status IN ('failed','dead')`,
        [tenantId],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level !== "department",
        count,
        severity: severityFromCount(count, 8, 2),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `job:${r.id}`,
          label: r.job_type || `Job #${r.id}`,
          detail: r.last_error ? String(r.last_error).slice(0, 120) : r.status,
          occurredAt: iso(r.updated_at),
          severity: r.status === "dead" ? ("critical" as Severity) : ("high" as Severity),
        })),
      }
    },
  )
}

async function loadPaymentExceptions(_tenantId: number, scope: RiskScope) {
  return safe(
    { key: "payments", label: "Payment exceptions", category: "finance", drillHref: "/modules/finance/payments" },
    async () => {
      // Legacy company-scoped books: no tenant_id column. Reversed payments are
      // the risk signal (a completed payment that had to be backed out).
      const rows = await query<any[]>(
        `SELECT id, payment_id, party_name, amount, status, reversal_reason, payment_date
           FROM payments
          WHERE status = 'Reversed'
          ORDER BY payment_date DESC LIMIT ${ITEM_LIMIT}`,
        [],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(payment_date) m FROM payments WHERE status = 'Reversed'`,
        [],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count, 10, 3),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `pay:${r.id}`,
          label: r.payment_id || `Payment #${r.id}`,
          detail: r.reversal_reason ? String(r.reversal_reason).slice(0, 120) : "Reversed",
          amount: r.amount != null ? num(r.amount) : null,
          occurredAt: iso(r.payment_date),
          severity: "high" as Severity,
          sensitive: r.party_name ? { party: r.party_name } : undefined,
        })),
      }
    },
  )
}

// --- Finance compliance sources --------------------------------------------

async function loadGstCompliance(_tenantId: number, scope: RiskScope) {
  return safe(
    { key: "gst_compliance", label: "GST filing status", category: "finance", drillHref: "/modules/finance/gst" },
    async () => {
      const rows = await query<any[]>(
        `SELECT return_type, period, status, arn, updated_at
           FROM gst_return_filings
          ORDER BY period DESC, id DESC LIMIT ${ITEM_LIMIT}`,
        [],
      )
      const [{ amended, m }] = await query<any[]>(
        `SELECT SUM(status = 'Amended') amended, MAX(updated_at) m FROM gst_return_filings`,
        [],
      )
      // Amendments are the compliance exception signal for filed returns.
      const count = num(amended)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count, 6, 2),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `gst:${r.return_type}:${r.period}`,
          label: `${r.return_type} ${r.period}`,
          detail: r.arn ? `ARN ${r.arn} · ${r.status}` : r.status,
          occurredAt: iso(r.updated_at),
          severity: r.status === "Amended" ? ("medium" as Severity) : ("ok" as Severity),
        })),
      }
    },
  )
}

async function loadTdsCompliance(_tenantId: number, scope: RiskScope) {
  return safe(
    { key: "tds_compliance", label: "TDS filing status", category: "finance", drillHref: "/modules/finance/tds" },
    async () => {
      const rows = await query<any[]>(
        `SELECT form_type, quarter, financial_year, status, updated_at
           FROM tds_returns
          ORDER BY financial_year DESC, quarter DESC, id DESC LIMIT ${ITEM_LIMIT}`,
        [],
      )
      const [{ pending, m }] = await query<any[]>(
        `SELECT SUM(status <> 'Filed') pending, MAX(updated_at) m FROM tds_returns`,
        [],
      )
      const count = num(pending)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count, 4, 2),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `tds:${r.form_type}:${r.quarter}:${r.financial_year}`,
          label: `${r.form_type} ${r.quarter} ${r.financial_year}`,
          detail: r.status,
          occurredAt: iso(r.updated_at),
          severity: r.status !== "Filed" ? ("medium" as Severity) : ("ok" as Severity),
        })),
      }
    },
  )
}

async function loadReconciliation(_tenantId: number, scope: RiskScope) {
  return safe(
    { key: "reconciliation", label: "Bank reconciliation", category: "finance", drillHref: "/modules/finance/bank-reconciliation" },
    async () => {
      const rows = await query<any[]>(
        `SELECT transaction_id, amount, txn_date, reconciliation_status
           FROM bank_transactions
          WHERE COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled'
          ORDER BY txn_date DESC LIMIT ${ITEM_LIMIT}`,
        [],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(txn_date) m FROM bank_transactions
          WHERE COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled'`,
        [],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count, 20, 5),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `bank:${r.transaction_id}`,
          label: `Txn ${r.transaction_id}`,
          detail: r.reconciliation_status || "Unreconciled",
          amount: r.amount != null ? num(r.amount) : null,
          occurredAt: iso(r.txn_date),
          severity: "medium" as Severity,
        })),
      }
    },
  )
}

// --- HR & contract sources --------------------------------------------------

async function loadHrDocuments(_tenantId: number, scope: RiskScope) {
  return safe(
    { key: "hr_documents", label: "Employee documents", category: "hr", drillHref: "/modules/hr/documents" },
    async () => {
      const rows = await query<any[]>(
        `SELECT id, employee_id, type_name, expiry_date
           FROM hr_employee_documents
          WHERE expiry_date IS NOT NULL AND expiry_date <= (CURDATE() + INTERVAL 30 DAY)
          ORDER BY expiry_date ASC LIMIT ${ITEM_LIMIT}`,
        [],
      )
      const [{ c }] = await query<any[]>(
        `SELECT COUNT(*) c FROM hr_employee_documents
          WHERE expiry_date IS NOT NULL AND expiry_date <= (CURDATE() + INTERVAL 30 DAY)`,
        [],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count, 15, 4),
        asOf: new Date().toISOString(),
        items: rows.map((r) => ({
          id: `hrdoc:${r.id}`,
          label: r.type_name || `Document #${r.id}`,
          detail: `Employee ${r.employee_id} · expires ${r.expiry_date}`,
          occurredAt: iso(r.expiry_date),
          severity: "medium" as Severity,
          sensitive: { employee: String(r.employee_id) },
        })),
      }
    },
  )
}

async function loadHrAttendance(_tenantId: number, scope: RiskScope) {
  return safe(
    { key: "hr_attendance", label: "Attendance regularisations", category: "hr", drillHref: "/modules/hr/attendance" },
    async () => {
      const rows = await query<any[]>(
        `SELECT id, request_id, employee_name, status, created_at
           FROM hr_attendance_regularisation
          WHERE status = 'Pending'
          ORDER BY created_at ASC LIMIT ${ITEM_LIMIT}`,
        [],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(created_at) m FROM hr_attendance_regularisation WHERE status = 'Pending'`,
        [],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `att:${r.id}`,
          label: r.request_id || `Regularisation #${r.id}`,
          detail: "Pending review",
          occurredAt: iso(r.created_at),
          severity: "low" as Severity,
          sensitive: r.employee_name ? { employee: r.employee_name } : undefined,
        })),
      }
    },
  )
}

async function loadHrTraining(tenantId: number, scope: RiskScope) {
  return safe(
    { key: "hr_training", label: "Training compliance", category: "hr", drillHref: "/modules/hr/training" },
    async () => {
      const rows = await query<any[]>(
        `SELECT id, employee_id, status, due_date
           FROM training_assignments
          WHERE tenant_id = ?
            AND status <> 'completed'
            AND (status = 'overdue' OR (due_date IS NOT NULL AND due_date < CURDATE()))
          ORDER BY due_date ASC LIMIT ${ITEM_LIMIT}`,
        [tenantId],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(due_date) m FROM training_assignments
          WHERE tenant_id = ?
            AND status <> 'completed'
            AND (status = 'overdue' OR (due_date IS NOT NULL AND due_date < CURDATE()))`,
        [tenantId],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count, 25, 8),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `train:${r.id}`,
          label: `Assignment #${r.id}`,
          detail: `Employee ${r.employee_id} · due ${r.due_date ?? "n/a"}`,
          occurredAt: iso(r.due_date),
          severity: "medium" as Severity,
          sensitive: { employee: String(r.employee_id) },
        })),
      }
    },
  )
}

async function loadContractObligations(_tenantId: number, scope: RiskScope) {
  return safe(
    { key: "contract_obligations", label: "Contract obligations", category: "hr", drillHref: "/modules/legal/contracts" },
    async () => {
      const rows = await query<any[]>(
        `SELECT id, title, party_name, status, end_date, renewal_date
           FROM legal_generated_contracts
          WHERE (end_date IS NOT NULL AND end_date <= (CURDATE() + INTERVAL 60 DAY))
             OR (renewal_date IS NOT NULL AND renewal_date <= (CURDATE() + INTERVAL 60 DAY))
          ORDER BY COALESCE(renewal_date, end_date) ASC LIMIT ${ITEM_LIMIT}`,
        [],
      )
      const [{ c, m }] = await query<any[]>(
        `SELECT COUNT(*) c, MAX(updated_at) m FROM legal_generated_contracts
          WHERE (end_date IS NOT NULL AND end_date <= (CURDATE() + INTERVAL 60 DAY))
             OR (renewal_date IS NOT NULL AND renewal_date <= (CURDATE() + INTERVAL 60 DAY))`,
        [],
      )
      const count = num(c)
      return {
        available: true,
        scopeApplied: scope.level === "group" || scope.level === "company",
        count,
        severity: severityFromCount(count, 10, 3),
        asOf: iso(m),
        items: rows.map((r) => ({
          id: `contract:${r.id}`,
          label: r.title || `Contract #${r.id}`,
          detail: `${r.status} · ${r.renewal_date ? `renews ${r.renewal_date}` : `ends ${r.end_date}`}`,
          occurredAt: iso(r.renewal_date || r.end_date),
          severity: "medium" as Severity,
          sensitive: r.party_name ? { party: r.party_name } : undefined,
        })),
      }
    },
  )
}

/**
 * Compute the full dashboard live from every source. Never throws for a single
 * broken source — those degrade to `available: false`.
 */
export async function computeRiskComplianceDashboard(
  tenantId: number,
  scope: RiskScope,
): Promise<RiskComplianceDashboard> {
  const sources = await Promise.all([
    loadPendingApprovals(tenantId, scope),
    loadMakerChecker(tenantId, scope),
    loadFailedAuth(tenantId, scope),
    loadFailedJobs(tenantId, scope),
    loadPaymentExceptions(tenantId, scope),
    loadGstCompliance(tenantId, scope),
    loadTdsCompliance(tenantId, scope),
    loadReconciliation(tenantId, scope),
    loadHrDocuments(tenantId, scope),
    loadHrAttendance(tenantId, scope),
    loadHrTraining(tenantId, scope),
    loadContractObligations(tenantId, scope),
  ])

  const categories: RiskComplianceDashboard["categories"] = {
    operational: { openItems: 0, critical: 0, sources: 0 },
    finance: { openItems: 0, critical: 0, sources: 0 },
    hr: { openItems: 0, critical: 0, sources: 0 },
  }
  let openItems = 0
  let critical = 0
  let high = 0
  let available = 0
  for (const s of sources) {
    if (s.available) available += 1
    openItems += s.count
    if (s.severity === "critical") critical += 1
    if (s.severity === "high") high += 1
    const cat = categories[s.category]
    cat.openItems += s.count
    if (s.severity === "critical") cat.critical += 1
    if (s.available) cat.sources += 1
  }

  return {
    tenantId,
    scope,
    scopeKey: scopeKeyOf(scope),
    computedAt: new Date().toISOString(),
    masked: false,
    totals: {
      openItems,
      critical,
      high,
      sourcesAvailable: available,
      sourcesMissing: sources.length - available,
    },
    categories,
    sources,
  }
}

/**
 * Return a copy of the dashboard with sensitive fields masked. Used for exports
 * and any caller not explicitly authorized to view PII/counterparties.
 */
export function maskDashboard(dash: RiskComplianceDashboard): RiskComplianceDashboard {
  return {
    ...dash,
    masked: true,
    sources: dash.sources.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (!it.sensitive) return it
        const masked: Record<string, string> = {}
        for (const k of Object.keys(it.sensitive)) masked[k] = "•••• (masked)"
        // Also scrub sensitive substrings that may appear in the human detail.
        let detail = it.detail ?? null
        if (detail) {
          for (const v of Object.values(it.sensitive)) {
            if (v) detail = detail.split(v).join("•••• (masked)")
          }
        }
        return { ...it, detail, sensitive: masked }
      }),
    })),
  }
}

/** Staleness helper: true when `computedAt` is older than `maxAgeMs`. */
export function isStale(computedAt: string, maxAgeMs: number, now = Date.now()): boolean {
  const t = new Date(computedAt).getTime()
  if (Number.isNaN(t)) return true
  return now - t > maxAgeMs
}
