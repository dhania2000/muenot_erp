import "server-only"
// =============================================================================
// Operations Finance layer (Phases 42-45) — READ-ONLY derived reports.
// -----------------------------------------------------------------------------
// These reports are computed live from the real source systems and are never
// stored as duplicate rows:
//   * Vendor Cost      ← Finance purchase_bills (grouped by vendor + project)
//   * Resource Cost    ← approved operations_timesheets × Resources cost rate
//   * Project Cost     ← Vendor bills + Finance expenses + labour, per project
//   * Budget vs Actual ← operations_projects.budget_amount vs derived actual
//
// Nothing here writes to Finance or to the operations cost tables — it only
// aggregates existing rows, so there is a single source of truth for money.
// Every table/column is probed with tableColumns() first so an install whose
// Finance schema differs degrades to "no data" instead of crashing.
// =============================================================================

import { query, tableColumns } from "@/lib/db"
import { computeProjectProgress } from "@/lib/operations-automation"
import {
  computeProfitability,
  type ProfitabilityInput,
  type ProjectProfitabilityRow,
} from "@/lib/project-profitability-model"

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** Stable per-project grouping key across Finance / Operations source rows. */
function projectKey(id: unknown, name: unknown): string {
  const n = name != null ? String(name).trim() : ""
  if (n) return n.toLowerCase()
  const i = id != null ? String(id).trim() : ""
  return i ? `#${i}` : "__unassigned__"
}
function projectLabel(id: unknown, name: unknown): string {
  const n = name != null ? String(name).trim() : ""
  if (n) return n
  const i = id != null ? String(id).trim() : ""
  return i ? `Project ${i}` : "Unassigned"
}

/** Convert a resource's stored rate to an hourly figure using rate_type. */
function normaliseToHourly(rate: number, rateType: unknown): number {
  const type = String(rateType ?? "").toLowerCase()
  if (type === "monthly") return round2(rate / 160)
  if (type === "daily") return round2(rate / 8)
  return rate
}

/** hourly-rate lookup table keyed by both resource_id and lowercased name. */
async function resourceRateIndex(): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  const cols = await tableColumns("operations_resources")
  if (!cols.has("cost_rate")) return index
  const rows = await query<any[]>(
    `SELECT resource_id, resource_name, cost_rate, rate_type FROM operations_resources`,
  ).catch(() => [] as any[])
  for (const r of rows) {
    const hourly = normaliseToHourly(toNumber(r.cost_rate), r.rate_type)
    if (r.resource_id != null && String(r.resource_id) !== "") index.set(`id:${String(r.resource_id)}`, hourly)
    if (r.resource_name) index.set(`name:${String(r.resource_name).toLowerCase()}`, hourly)
  }
  return index
}

// ---------------------------------------------------------------------------
// Vendor Cost (Phase 44)
// ---------------------------------------------------------------------------
export type VendorCostRow = {
  vendor_name: string
  project_name: string
  bill_count: number
  invoice_amount: number
  paid_amount: number
  outstanding_amount: number
  payment_status: string
}

export async function vendorCostReport(): Promise<VendorCostRow[]> {
  const cols = await tableColumns("purchase_bills")
  if (!cols.size) return []
  const rows = await query<any[]>(
    `SELECT vendor_id, vendor_name, project_id, project_name,
            COUNT(*) bill_count,
            COALESCE(SUM(gross_bill_amount),0) invoice_amount,
            COALESCE(SUM(amount_paid),0) paid_amount,
            COALESCE(SUM(outstanding_amount),0) outstanding_amount
       FROM purchase_bills
      GROUP BY vendor_id, vendor_name, project_id, project_name
      ORDER BY invoice_amount DESC`,
  ).catch(() => [] as any[])

  return rows.map((r) => {
    const invoice = round2(toNumber(r.invoice_amount))
    const paid = round2(toNumber(r.paid_amount))
    const outstanding = round2(toNumber(r.outstanding_amount))
    const payment_status = outstanding <= 0 && invoice > 0 ? "Paid" : paid > 0 ? "Partially Paid" : "Unpaid"
    return {
      vendor_name: r.vendor_name ? String(r.vendor_name) : "Unknown vendor",
      project_name: projectLabel(r.project_id, r.project_name),
      bill_count: toNumber(r.bill_count),
      invoice_amount: invoice,
      paid_amount: paid,
      outstanding_amount: outstanding,
      payment_status,
    }
  })
}

// ---------------------------------------------------------------------------
// Resource Cost (Phase 43)
// ---------------------------------------------------------------------------
export type ResourceCostRow = {
  resource_name: string
  project_name: string
  hours: number
  billable_hours: number
  hourly_rate: number
  total_cost: number
}

export async function resourceCostReport(): Promise<ResourceCostRow[]> {
  const cols = await tableColumns("operations_timesheets")
  if (!cols.size) return []
  const billableExpr = cols.has("billable_hours") ? "COALESCE(SUM(billable_hours),0)" : "0"
  const rows = await query<any[]>(
    `SELECT resource_id, resource_name, project_id, project_name,
            COALESCE(SUM(hours_worked),0) hours,
            ${billableExpr} billable_hours
       FROM operations_timesheets
      WHERE approval_status = 'Approved'
      GROUP BY resource_id, resource_name, project_id, project_name`,
  ).catch(() => [] as any[])

  const rateIndex = await resourceRateIndex()
  const result = rows.map((r) => {
    const hours = round2(toNumber(r.hours))
    const rate =
      rateIndex.get(`id:${String(r.resource_id ?? "")}`) ??
      rateIndex.get(`name:${String(r.resource_name ?? "").toLowerCase()}`) ??
      0
    return {
      resource_name: r.resource_name ? String(r.resource_name) : "Unknown resource",
      project_name: projectLabel(r.project_id, r.project_name),
      hours,
      billable_hours: round2(toNumber(r.billable_hours)),
      hourly_rate: round2(rate),
      total_cost: round2(hours * rate),
    }
  })
  return result.sort((a, b) => b.total_cost - a.total_cost)
}

// ---------------------------------------------------------------------------
// Per-project actual cost building blocks (shared by Project Cost + BvA)
// ---------------------------------------------------------------------------
type ProjectActuals = {
  label: string
  vendor: number
  expenses: number
  labour: number
}

async function perProjectActuals(): Promise<Map<string, ProjectActuals>> {
  const map = new Map<string, ProjectActuals>()
  const bump = (id: unknown, name: unknown, field: keyof Omit<ProjectActuals, "label">, amount: number) => {
    const key = projectKey(id, name)
    const existing = map.get(key) ?? { label: projectLabel(id, name), vendor: 0, expenses: 0, labour: 0 }
    existing[field] = round2(existing[field] + amount)
    if (existing.label === "Unassigned") existing.label = projectLabel(id, name)
    map.set(key, existing)
  }

  // Vendor bills
  if ((await tableColumns("purchase_bills")).size) {
    const rows = await query<any[]>(
      `SELECT project_id, project_name, COALESCE(SUM(gross_bill_amount),0) amt
         FROM purchase_bills GROUP BY project_id, project_name`,
    ).catch(() => [] as any[])
    for (const r of rows) bump(r.project_id, r.project_name, "vendor", toNumber(r.amt))
  }

  // Finance expenses
  const expCols = await tableColumns("expenses")
  if (expCols.size) {
    const amtCol = expCols.has("gross_amount") ? "gross_amount" : expCols.has("net_payable") ? "net_payable" : null
    if (amtCol) {
      const rows = await query<any[]>(
        `SELECT project_id, project_name, COALESCE(SUM(${amtCol}),0) amt
           FROM expenses GROUP BY project_id, project_name`,
      ).catch(() => [] as any[])
      for (const r of rows) bump(r.project_id, r.project_name, "expenses", toNumber(r.amt))
    }
  }

  // Labour from approved timesheets × resource rate
  for (const r of await resourceCostReport()) {
    // resourceCostReport already labels by project_name; re-key by label.
    bump(null, r.project_name, "labour", r.total_cost)
  }

  return map
}

// ---------------------------------------------------------------------------
// Project Cost (Phase 42) — one row per project per cost category
// ---------------------------------------------------------------------------
export type ProjectCostRow = {
  project_name: string
  cost_category: string
  actual_cost: number
}

export async function projectCostReport(): Promise<ProjectCostRow[]> {
  const map = await perProjectActuals()
  const rows: ProjectCostRow[] = []
  for (const p of map.values()) {
    if (p.vendor > 0) rows.push({ project_name: p.label, cost_category: "Vendor Bills", actual_cost: p.vendor })
    if (p.expenses > 0) rows.push({ project_name: p.label, cost_category: "Expenses", actual_cost: p.expenses })
    if (p.labour > 0) rows.push({ project_name: p.label, cost_category: "Labour (Timesheets)", actual_cost: p.labour })
    const total = round2(p.vendor + p.expenses + p.labour)
    if (total > 0) rows.push({ project_name: p.label, cost_category: "Total", actual_cost: total })
  }
  return rows.sort((a, b) => a.project_name.localeCompare(b.project_name) || (a.cost_category === "Total" ? 1 : -1))
}

// ---------------------------------------------------------------------------
// Budget vs Actual (Phase 45)
// ---------------------------------------------------------------------------
export type BudgetVsActualRow = {
  project_name: string
  budget_amount: number
  actual_amount: number
  variance: number
  variance_percent: number
  status: string
}

export async function budgetVsActualReport(): Promise<BudgetVsActualRow[]> {
  const actuals = await perProjectActuals()

  // Budgets from the project master (single authoritative planning figure).
  const budgetByKey = new Map<string, { label: string; budget: number }>()
  const projCols = await tableColumns("operations_projects")
  if (projCols.has("budget_amount")) {
    const rows = await query<any[]>(
      `SELECT id, project_name, budget_amount FROM operations_projects`,
    ).catch(() => [] as any[])
    for (const r of rows) {
      const budget = toNumber(r.budget_amount)
      if (budget <= 0) continue
      budgetByKey.set(projectKey(r.id, r.project_name), { label: projectLabel(r.id, r.project_name), budget })
    }
  }

  const keys = new Set<string>([...actuals.keys(), ...budgetByKey.keys()])
  const rows: BudgetVsActualRow[] = []
  for (const key of keys) {
    const a = actuals.get(key)
    const b = budgetByKey.get(key)
    const label = b?.label ?? a?.label ?? "Unassigned"
    const budget = round2(b?.budget ?? 0)
    const actual = round2((a?.vendor ?? 0) + (a?.expenses ?? 0) + (a?.labour ?? 0))
    if (budget === 0 && actual === 0) continue
    const variance = round2(budget - actual)
    const variancePercent = budget > 0 ? round2((variance / budget) * 100) : actual > 0 ? -100 : 0
    const status = budget === 0 ? "No Budget" : actual > budget ? "Over Budget" : actual >= budget * 0.9 ? "At Risk" : "Under Budget"
    rows.push({
      project_name: label,
      budget_amount: budget,
      actual_amount: actual,
      variance,
      variance_percent: variancePercent,
      status,
    })
  }
  return rows.sort((a, b) => b.actual_amount - a.actual_amount)
}

// ---------------------------------------------------------------------------
// Project Profitability (Spec44 #204) — invoiced revenue vs derived cost
// ---------------------------------------------------------------------------
export async function projectProfitabilityReport(): Promise<ProjectProfitabilityRow[]> {
  const actuals = await perProjectActuals()
  const projCols = await tableColumns("operations_projects")
  const projects = projCols.size
    ? await query<any[]>(
        `SELECT id, project_name${projCols.has("budget_amount") ? ", budget_amount" : ""} FROM operations_projects`,
      ).catch(() => [] as any[])
    : []
  const nameById = new Map(projects.map((p) => [String(p.id), p.project_name]))

  const entries = new Map<string, ProfitabilityInput>()
  const entry = (key: string, label: string) => {
    const e = entries.get(key) ?? { key, label, revenue: 0, cost: 0, budget: 0, progress: null }
    entries.set(key, e)
    return e
  }
  for (const p of projects) entry(projectKey(p.id, p.project_name), projectLabel(p.id, p.project_name)).budget = toNumber(p.budget_amount)
  for (const [key, a] of actuals) entry(key, a.label).cost = round2(a.vendor + a.expenses + a.labour)

  const invCols = await tableColumns("sales_invoices")
  const amtCol = invCols.has("invoice_total") ? "invoice_total" : invCols.has("net_receivable") ? "net_receivable" : null
  if (invCols.has("project_id") && amtCol) {
    const statusFilter = invCols.has("invoice_status") ? `AND COALESCE(invoice_status,'') NOT IN ('Cancelled','Draft','Void')` : ""
    const typeFilter = invCols.has("invoice_type") ? `AND (invoice_type IS NULL OR invoice_type <> 'Proforma Invoice')` : ""
    const rows = await query<any[]>(
      `SELECT project_id, COALESCE(SUM(${amtCol}),0) amt FROM sales_invoices
        WHERE project_id IS NOT NULL AND project_id <> '' ${statusFilter} ${typeFilter}
        GROUP BY project_id`,
    ).catch(() => [] as any[])
    for (const r of rows) {
      const name = nameById.get(String(r.project_id))
      entry(projectKey(r.project_id, name), projectLabel(r.project_id, name)).revenue += toNumber(r.amt)
    }
  }

  const progress = await computeProjectProgress().catch(() => [])
  for (const p of progress) {
    const e = entries.get(projectKey(p.project_id, p.project_name))
    if (e) e.progress = p.progress
  }
  return computeProfitability([...entries.values()])
}

export type FinanceReportView = "project_cost" | "resource_cost" | "vendor_cost" | "budget_vs_actual" | "profitability"

export async function financeReport(view: FinanceReportView) {
  switch (view) {
    case "vendor_cost":
      return vendorCostReport()
    case "resource_cost":
      return resourceCostReport()
    case "project_cost":
      return projectCostReport()
    case "budget_vs_actual":
      return budgetVsActualReport()
    case "profitability":
      return projectProfitabilityReport()
  }
}
