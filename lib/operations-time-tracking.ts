import "server-only"
// =============================================================================
// Time Tracking (SPEC 148) — normalized timesheet analytics + payroll/billing.
// -----------------------------------------------------------------------------
// PHASE 1 audit conclusion: raw effort already lives in a single source of
// truth — operations_timesheets — with a Draft → Submitted → Approved → Rejected
// approval lifecycle and billable/non-billable hour columns. What was missing is
// a *normalized* view over that flat table:
//
//   * a canonical TimeEntry shape (resource / project / client / day)
//   * regular vs OVERTIME split (daily hours beyond the standard working day)
//   * CLIENT time (timesheets only carry project_id; client comes from Projects)
//   * roll-ups by resource, project and client
//   * a PAYROLL/BILLING roll-up (regular pay + overtime pay at a premium)
//
// Everything here is READ-ONLY and derived live from operations_timesheets, so
// it always reconciles back to the timesheets themselves (Phase 4). The pure
// calculators (PHASE 1) and aggregators (PHASE 2) take plain inputs and are
// exported for direct validation; only timeTrackingReport() touches the DB.
// =============================================================================

import { query, tableColumns } from "@/lib/db"

/** A standard working day. Daily hours beyond this count as overtime. */
export const STANDARD_DAILY_HOURS = 8

/** Overtime premium — overtime hours are paid at 1.5× the base hourly rate. */
export const OVERTIME_MULTIPLIER = 1.5

/** Hours assumed per month when converting a monthly cost rate to hourly. */
const MONTHLY_HOURS = 160
/** Hours assumed per day when converting a daily cost rate to hourly. */
const DAILY_HOURS = 8

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value))
}
/** Percentage helper — returns 0 (not NaN/Infinity) when the base is zero. */
function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? round2((numerator / denominator) * 100) : 0
}
function has(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] !== undefined && raw[key] !== null && raw[key] !== ""
}

// ---------------------------------------------------------------------------
// PHASE 1 — Calculations (pure, side-effect free, exported for validation)
// ---------------------------------------------------------------------------

/**
 * Hours between two `HH:MM` (or `HH:MM:SS`) clock strings. A finish time that is
 * less than or equal to the start is treated as crossing midnight, so a night
 * shift returns positive hours instead of a negative/zero span.
 */
export function hoursFromClock(start: unknown, end: unknown): number {
  const parse = (value: unknown): number | null => {
    const m = String(value ?? "").match(/^(\d{1,2}):(\d{2})/)
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
  }
  const a = parse(start)
  const b = parse(end)
  if (a === null || b === null) return 0
  const minutes = b > a ? b - a : b + 24 * 60 - a
  return round2(minutes / 60)
}

export type RawTimeEntry = {
  resource_id?: unknown
  resource_name?: unknown
  project_id?: unknown
  project_name?: unknown
  client_name?: unknown
  work_date?: unknown
  hours_worked?: unknown
  billable_hours?: unknown
  non_billable_hours?: unknown
  start_time?: unknown
  end_time?: unknown
  approval_status?: unknown
}

export type EntryHours = {
  totalHours: number
  billableHours: number
  nonBillableHours: number
}

/**
 * Resolve a single timesheet row's hour split from whichever columns are
 * populated, defensively and without ever producing negatives:
 *   * total  ← hours_worked, else derived from start/end clock times
 *   * billable is preferred explicit, else total − non_billable, else all-billable
 *   * billable is clamped to [0, total] so non-billable can never go negative
 */
export function computeEntryHours(raw: RawTimeEntry): EntryHours {
  const record = raw as Record<string, unknown>
  let total = toNumber(raw.hours_worked)
  if (total <= 0) total = hoursFromClock(raw.start_time, raw.end_time)
  total = Math.max(0, round2(total))

  let billable: number
  if (has(record, "billable_hours")) billable = toNumber(raw.billable_hours)
  else if (has(record, "non_billable_hours")) billable = total - toNumber(raw.non_billable_hours)
  else billable = total
  billable = round2(clamp(0, total, billable))
  const nonBillable = round2(total - billable)

  return { totalHours: total, billableHours: billable, nonBillableHours: nonBillable }
}

export type RegularOvertime = { regularHours: number; overtimeHours: number }

/**
 * Split a single day's total hours into regular and overtime. Overtime is the
 * portion of a day worked beyond the standard working day. Pure.
 */
export function splitRegularOvertime(
  dayTotalHours: number,
  standardDaily: number = STANDARD_DAILY_HOURS,
): RegularOvertime {
  const total = Math.max(0, round2(toNumber(dayTotalHours)))
  const cap = Math.max(0, standardDaily)
  const regularHours = round2(Math.min(total, cap))
  const overtimeHours = round2(Math.max(0, total - cap))
  return { regularHours, overtimeHours }
}

// ---------------------------------------------------------------------------
// PHASE 2 — Normalization + aggregation services (pure over TimeEntry[])
// ---------------------------------------------------------------------------

/** `YYYY-MM` period bucket for a date-ish value, or "" when unparseable. */
function periodOf(value: unknown): string {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}` : ""
}

export type TimeEntry = {
  resource_id: string
  resource_name: string
  project_id: string
  project_name: string
  client_name: string
  work_date: string
  period: string
  totalHours: number
  billableHours: number
  nonBillableHours: number
  approvalStatus: string
}

/** Normalize a raw timesheet row into the canonical TimeEntry shape. Pure. */
export function normalizeEntry(raw: RawTimeEntry): TimeEntry {
  const { totalHours, billableHours, nonBillableHours } = computeEntryHours(raw)
  const workDate = raw.work_date ? String(raw.work_date).slice(0, 10) : ""
  return {
    resource_id: raw.resource_id != null ? String(raw.resource_id) : "",
    resource_name: raw.resource_name ? String(raw.resource_name) : "Unknown resource",
    project_id: raw.project_id != null ? String(raw.project_id) : "",
    project_name: raw.project_name ? String(raw.project_name) : "",
    client_name: raw.client_name ? String(raw.client_name) : "Unassigned",
    work_date: workDate,
    period: periodOf(workDate),
    totalHours,
    billableHours,
    nonBillableHours,
    approvalStatus: raw.approval_status ? String(raw.approval_status) : "Draft",
  }
}

/**
 * Regular/overtime split aggregated per resource, keyed by period. Overtime is
 * strictly a DAILY concept, so hours are first summed per (resource, work_date)
 * and split there, then the daily splits are bucketed into their period. Entries
 * with no work_date cannot be attributed to a day and contribute regular-only.
 */
function regularOvertimeByPeriod(entries: TimeEntry[]): Map<string, Map<string, RegularOvertime>> {
  // resourceKey → workDate → summed total hours that day
  const dayTotals = new Map<string, Map<string, number>>()
  for (const e of entries) {
    const resourceKey = e.resource_id || e.resource_name.toLowerCase()
    const dayKey = e.work_date || `nodate:${e.period}`
    const byDay = dayTotals.get(resourceKey) ?? new Map<string, number>()
    byDay.set(dayKey, round2((byDay.get(dayKey) ?? 0) + e.totalHours))
    dayTotals.set(resourceKey, byDay)
  }

  const result = new Map<string, Map<string, RegularOvertime>>()
  for (const [resourceKey, byDay] of dayTotals) {
    const byPeriod = new Map<string, RegularOvertime>()
    for (const [dayKey, total] of byDay) {
      const period = dayKey.startsWith("nodate:") ? dayKey.slice("nodate:".length) : periodOf(dayKey)
      const split = splitRegularOvertime(total)
      const acc = byPeriod.get(period) ?? { regularHours: 0, overtimeHours: 0 }
      acc.regularHours = round2(acc.regularHours + split.regularHours)
      acc.overtimeHours = round2(acc.overtimeHours + split.overtimeHours)
      byPeriod.set(period, acc)
    }
    result.set(resourceKey, byPeriod)
  }
  return result
}

export type TimeSummary = {
  entryCount: number
  resourceCount: number
  projectCount: number
  clientCount: number
  totalHours: number
  billableHours: number
  nonBillableHours: number
  regularHours: number
  overtimeHours: number
  billablePercent: number
  overtimePercent: number
}

/** Portfolio totals across a set of normalized entries. Pure. */
export function summarizeTimeEntries(entries: TimeEntry[]): TimeSummary {
  const totals = entries.reduce(
    (acc, e) => {
      acc.total += e.totalHours
      acc.billable += e.billableHours
      acc.nonBillable += e.nonBillableHours
      return acc
    },
    { total: 0, billable: 0, nonBillable: 0 },
  )

  let regularHours = 0
  let overtimeHours = 0
  for (const byPeriod of regularOvertimeByPeriod(entries).values()) {
    for (const ro of byPeriod.values()) {
      regularHours = round2(regularHours + ro.regularHours)
      overtimeHours = round2(overtimeHours + ro.overtimeHours)
    }
  }

  return {
    entryCount: entries.length,
    resourceCount: new Set(entries.map((e) => e.resource_id || e.resource_name.toLowerCase())).size,
    projectCount: new Set(entries.filter((e) => e.project_id).map((e) => e.project_id)).size,
    clientCount: new Set(entries.map((e) => e.client_name.toLowerCase())).size,
    totalHours: round2(totals.total),
    billableHours: round2(totals.billable),
    nonBillableHours: round2(totals.nonBillable),
    regularHours,
    overtimeHours,
    billablePercent: pct(totals.billable, totals.total),
    overtimePercent: pct(overtimeHours, totals.total),
  }
}

export type TimeGroupRow = {
  key: string
  label: string
  period: string
  totalHours: number
  billableHours: number
  nonBillableHours: number
  regularHours: number
  overtimeHours: number
  billablePercent: number
  entryCount: number
}

type GroupDimension = "resource" | "project" | "client"

function groupKeyAndLabel(entry: TimeEntry, dimension: GroupDimension): { key: string; label: string } {
  if (dimension === "resource")
    return { key: entry.resource_id || entry.resource_name.toLowerCase(), label: entry.resource_name }
  if (dimension === "project")
    return {
      key: entry.project_id || entry.project_name.toLowerCase() || "unassigned",
      label: entry.project_name || (entry.project_id ? `Project ${entry.project_id}` : "Unassigned"),
    }
  return { key: entry.client_name.toLowerCase(), label: entry.client_name }
}

/**
 * Roll entries up by resource / project / client within each period. Regular
 * and overtime are attributed from each entry's share of its resource's daily
 * split, so per-group overtime still reconciles to the portfolio total.
 */
export function rollupBy(entries: TimeEntry[], dimension: GroupDimension): TimeGroupRow[] {
  const roByResource = regularOvertimeByPeriod(entries)
  // Per-resource/period logged total, to prorate that resource's regular/OT
  // hours across the groups the hours were logged to.
  const resourcePeriodTotal = new Map<string, number>()
  for (const e of entries) {
    const rk = `${e.resource_id || e.resource_name.toLowerCase()}|${e.period}`
    resourcePeriodTotal.set(rk, round2((resourcePeriodTotal.get(rk) ?? 0) + e.totalHours))
  }

  const groups = new Map<string, TimeGroupRow>()
  for (const e of entries) {
    const { key, label } = groupKeyAndLabel(e, dimension)
    const groupKey = `${key}|${e.period}`
    const row =
      groups.get(groupKey) ??
      ({
        key,
        label,
        period: e.period,
        totalHours: 0,
        billableHours: 0,
        nonBillableHours: 0,
        regularHours: 0,
        overtimeHours: 0,
        billablePercent: 0,
        entryCount: 0,
      } satisfies TimeGroupRow)

    row.totalHours = round2(row.totalHours + e.totalHours)
    row.billableHours = round2(row.billableHours + e.billableHours)
    row.nonBillableHours = round2(row.nonBillableHours + e.nonBillableHours)
    row.entryCount += 1

    // Prorate this resource's daily regular/OT split onto the entry by hours share.
    const resourceKey = e.resource_id || e.resource_name.toLowerCase()
    const ro = roByResource.get(resourceKey)?.get(e.period)
    const denom = resourcePeriodTotal.get(`${resourceKey}|${e.period}`) ?? 0
    if (ro && denom > 0) {
      const share = e.totalHours / denom
      row.regularHours = round2(row.regularHours + ro.regularHours * share)
      row.overtimeHours = round2(row.overtimeHours + ro.overtimeHours * share)
    } else {
      row.regularHours = round2(row.regularHours + e.totalHours)
    }

    groups.set(groupKey, row)
  }

  const rows = Array.from(groups.values()).map((r) => ({
    ...r,
    billablePercent: pct(r.billableHours, r.totalHours),
  }))
  rows.sort((a, b) => b.period.localeCompare(a.period) || b.totalHours - a.totalHours)
  return rows
}

export type PayrollRow = {
  resource_id: string
  resource_name: string
  period: string
  hourlyRate: number
  regularHours: number
  overtimeHours: number
  regularPay: number
  overtimePay: number
  totalPay: number
}

/** resource key ("id:.." / "name:..") → hourly rate. */
export type RateResolver = (resourceId: string, resourceName: string) => number

/**
 * Payroll/billing roll-up: regular pay + overtime pay (at OVERTIME_MULTIPLIER)
 * per resource per period. Overtime uses the daily split so a person who works
 * long days is paid the premium even when their monthly total looks normal.
 * Pure — the caller supplies the hourly-rate resolver.
 */
export function computePayroll(entries: TimeEntry[], rateOf: RateResolver): PayrollRow[] {
  const roByResource = regularOvertimeByPeriod(entries)
  const meta = new Map<string, { resource_id: string; resource_name: string }>()
  for (const e of entries) {
    const rk = e.resource_id || e.resource_name.toLowerCase()
    if (!meta.has(rk)) meta.set(rk, { resource_id: e.resource_id, resource_name: e.resource_name })
  }

  const rows: PayrollRow[] = []
  for (const [resourceKey, byPeriod] of roByResource) {
    const info = meta.get(resourceKey) ?? { resource_id: "", resource_name: resourceKey }
    const hourlyRate = round2(Math.max(0, rateOf(info.resource_id, info.resource_name)))
    for (const [period, ro] of byPeriod) {
      const regularPay = round2(ro.regularHours * hourlyRate)
      const overtimePay = round2(ro.overtimeHours * hourlyRate * OVERTIME_MULTIPLIER)
      rows.push({
        resource_id: info.resource_id,
        resource_name: info.resource_name,
        period,
        hourlyRate,
        regularHours: ro.regularHours,
        overtimeHours: ro.overtimeHours,
        regularPay,
        overtimePay,
        totalPay: round2(regularPay + overtimePay),
      })
    }
  }
  rows.sort((a, b) => b.period.localeCompare(a.period) || b.totalPay - a.totalPay)
  return rows
}

/** Count entries per approval-lifecycle state, for the workflow view. */
export type ApprovalBreakdown = {
  draftHours: number
  submittedHours: number
  approvedHours: number
  rejectedHours: number
  draftCount: number
  submittedCount: number
  approvedCount: number
  rejectedCount: number
}

export function approvalBreakdown(entries: TimeEntry[]): ApprovalBreakdown {
  const b: ApprovalBreakdown = {
    draftHours: 0,
    submittedHours: 0,
    approvedHours: 0,
    rejectedHours: 0,
    draftCount: 0,
    submittedCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
  }
  for (const e of entries) {
    const state = e.approvalStatus.toLowerCase()
    if (state === "approved") {
      b.approvedHours = round2(b.approvedHours + e.totalHours)
      b.approvedCount += 1
    } else if (state === "submitted") {
      b.submittedHours = round2(b.submittedHours + e.totalHours)
      b.submittedCount += 1
    } else if (state === "rejected") {
      b.rejectedHours = round2(b.rejectedHours + e.totalHours)
      b.rejectedCount += 1
    } else {
      b.draftHours = round2(b.draftHours + e.totalHours)
      b.draftCount += 1
    }
  }
  return b
}

// ---------------------------------------------------------------------------
// DB-backed report (the only impure export)
// ---------------------------------------------------------------------------

/** Convert a resource's stored cost rate to an hourly figure using rate_type. */
function normaliseToHourly(costRate: unknown, rateType: unknown): number {
  const rate = toNumber(costRate)
  const type = String(rateType ?? "").toLowerCase()
  if (type === "monthly") return round2(rate / MONTHLY_HOURS)
  if (type === "daily") return round2(rate / DAILY_HOURS)
  return rate // hourly / fixed / unknown → treat as already hourly
}

/** resource_id / lowercased-name → hourly cost rate, from the Resources master. */
async function resourceRateIndex(): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  const cols = await tableColumns("operations_resources")
  if (!cols.has("cost_rate")) return index
  const hasType = cols.has("rate_type")
  const rows = await query<any[]>(
    `SELECT resource_id, resource_name, cost_rate${hasType ? ", rate_type" : ""} FROM operations_resources`,
  ).catch(() => [] as any[])
  for (const r of rows) {
    const hourly = normaliseToHourly(r.cost_rate, hasType ? r.rate_type : null)
    if (r.resource_id != null && String(r.resource_id) !== "") index.set(`id:${String(r.resource_id)}`, hourly)
    if (r.resource_name) index.set(`name:${String(r.resource_name).toLowerCase()}`, hourly)
  }
  return index
}

/** project_id → { project_name, client_name }, so timesheets gain CLIENT time. */
async function projectClientIndex(): Promise<Map<string, { project_name: string; client_name: string }>> {
  const index = new Map<string, { project_name: string; client_name: string }>()
  const cols = await tableColumns("operations_projects")
  if (!cols.has("project_id")) return index
  const rows = await query<any[]>(
    `SELECT project_id, project_name, client_name FROM operations_projects`,
  ).catch(() => [] as any[])
  for (const r of rows) {
    if (r.project_id == null || String(r.project_id) === "") continue
    index.set(String(r.project_id), {
      project_name: r.project_name ? String(r.project_name) : "",
      client_name: r.client_name ? String(r.client_name) : "",
    })
  }
  return index
}

export type TimeTrackingReport = {
  entries: TimeEntry[]
  summary: TimeSummary
  byResource: TimeGroupRow[]
  byProject: TimeGroupRow[]
  byClient: TimeGroupRow[]
  payroll: PayrollRow[]
  approval: ApprovalBreakdown
}

function emptyReport(): TimeTrackingReport {
  return {
    entries: [],
    summary: summarizeTimeEntries([]),
    byResource: [],
    byProject: [],
    byClient: [],
    payroll: [],
    approval: approvalBreakdown([]),
  }
}

/**
 * Build the normalized time-tracking report from operations_timesheets.
 *
 * Options:
 *   * period      — restrict to a `YYYY-MM` bucket.
 *   * approvedOnly (default true) — the roll-ups, payroll and headline summary
 *     are computed from APPROVED time only, so billing/payroll always reconcile
 *     to approved timesheets. The raw `entries` list still includes every state
 *     (with approvalStatus) plus an `approval` breakdown for the workflow view.
 */
export async function timeTrackingReport(options?: {
  period?: string
  approvedOnly?: boolean
}): Promise<TimeTrackingReport> {
  const cols = await tableColumns("operations_timesheets")
  if (!cols.size) return emptyReport()

  const approvedOnly = options?.approvedOnly !== false
  const period = options?.period

  const select = ["resource_id", "resource_name", "project_id", "project_name", "work_date", "hours_worked"]
  if (cols.has("billable_hours")) select.push("billable_hours")
  if (cols.has("non_billable_hours")) select.push("non_billable_hours")
  if (cols.has("start_time")) select.push("start_time")
  if (cols.has("end_time")) select.push("end_time")
  const hasApproval = cols.has("approval_status")
  if (hasApproval) select.push("approval_status")

  const where: string[] = ["work_date IS NOT NULL"]
  const args: unknown[] = []
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    where.push("LEFT(work_date,7) = ?")
    args.push(period)
  }

  const rows = await query<any[]>(
    `SELECT ${select.join(", ")} FROM operations_timesheets WHERE ${where.join(" AND ")}`,
    args,
  ).catch(() => [] as any[])
  if (!rows.length) return emptyReport()

  const projectIndex = await projectClientIndex()
  const rateIndex = await resourceRateIndex()

  // Normalize every row, enriching project_name / client_name from Projects.
  const allEntries: TimeEntry[] = rows.map((r) => {
    const meta = r.project_id != null ? projectIndex.get(String(r.project_id)) : undefined
    return normalizeEntry({
      ...r,
      project_name: r.project_name || meta?.project_name || "",
      client_name: meta?.client_name || "",
    })
  })

  // The billing/payroll truth set: approved only (unless a schema lacks the
  // column, in which case everything present is treated as reportable).
  const reportable = hasApproval && approvedOnly
    ? allEntries.filter((e) => e.approvalStatus.toLowerCase() === "approved")
    : allEntries

  const rateOf: RateResolver = (id, name) =>
    rateIndex.get(`id:${id}`) ?? rateIndex.get(`name:${name.toLowerCase()}`) ?? 0

  return {
    entries: allEntries,
    summary: summarizeTimeEntries(reportable),
    byResource: rollupBy(reportable, "resource"),
    byProject: rollupBy(reportable, "project"),
    byClient: rollupBy(reportable, "client"),
    payroll: computePayroll(reportable, rateOf),
    approval: approvalBreakdown(allEntries),
  }
}
