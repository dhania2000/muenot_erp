import "server-only"
import { query } from "@/lib/db"
import { getCurrentTenant } from "@/lib/tenant-context"

/**
 * Fiscal Year Engine (SPEC 161) — server-only.
 * ---------------------------------------------------------------------------
 * Configurable fiscal years per tenant and (optionally) per legal entity, each
 * broken into monthly financial periods. A period moves through three states:
 *
 *   Open   → postings allowed
 *   Closed → soft close, postings blocked (books signed off for the month)
 *   Locked → hard lock, postings blocked (period sealed)
 *
 * Closing or locking a period blocks any back-dated posting into that month via
 * the shared `assertPeriodOpen` guard (lib/finance-period-lock.ts consults
 * `isFiscalPeriodClosedOrLocked` below). A Closed or Locked period can only be
 * re-opened through an approval workflow: a user files a reopen request with a
 * reason, and an approver approves it (which returns the period to Open) or
 * rejects it (which leaves it sealed). This keeps a signed-off trial balance
 * from silently moving.
 *
 * Tables self-heal on first use (CREATE TABLE IF NOT EXISTS), matching the rest
 * of the Finance module. Every row carries `tenant_id` so fiscal calendars are
 * isolated per customer organization, and `entity_id` (0 = all entities /
 * tenant-wide) scopes a calendar to a single legal entity when required.
 */

export type PeriodStatus = "Open" | "Closed" | "Locked"
export type YearStatus = "Open" | "Closed"
export type ReopenStatus = "Pending" | "Approved" | "Rejected"

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// ---------------------------------------------------------------------------
// Pure helpers (no DB) — unit-tested in test/fiscal-year.test.ts
// ---------------------------------------------------------------------------

export type GeneratedPeriod = {
  seq: number
  name: string // e.g. "Apr 2026"
  periodKey: string // e.g. "2026-04"
  startDate: string // "YYYY-MM-DD"
  endDate: string // "YYYY-MM-DD"
}

/** Normalise a date-ish value to a UTC midnight Date, or null when invalid. */
function toUtcDate(value: string): Date | null {
  const s = String(value ?? "").trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`
}

/**
 * Split an inclusive [startDate, endDate] range into consecutive monthly
 * periods. The first period starts on `startDate` and the last ends on
 * `endDate`; interior periods span whole calendar months. Returns [] for an
 * invalid or inverted range.
 */
export function generateMonthlyPeriods(startDate: string, endDate: string): GeneratedPeriod[] {
  const start = toUtcDate(startDate)
  const end = toUtcDate(endDate)
  if (!start || !end || start.getTime() > end.getTime()) return []

  const periods: GeneratedPeriod[] = []
  let year = start.getUTCFullYear()
  let month = start.getUTCMonth()
  let seq = 1

  while (true) {
    const monthStart = new Date(Date.UTC(year, month, 1))
    const monthEnd = new Date(Date.UTC(year, month + 1, 0)) // last day of this month
    const pStart = monthStart.getTime() < start.getTime() ? start : monthStart
    const pEnd = monthEnd.getTime() > end.getTime() ? end : monthEnd

    periods.push({
      seq,
      name: `${MONTH_SHORT[month]} ${year}`,
      periodKey: `${year}-${String(month + 1).padStart(2, "0")}`,
      startDate: ymd(pStart),
      endDate: ymd(pEnd),
    })

    if (year === end.getUTCFullYear() && month === end.getUTCMonth()) break
    seq++
    month++
    if (month > 11) {
      month = 0
      year++
    }
  }

  return periods
}

/** A period may be closed (soft) only when it is currently Open. */
export function canClosePeriod(status: PeriodStatus): boolean {
  return status === "Open"
}

/** A period may be locked (hard) when Open or already Closed. */
export function canLockPeriod(status: PeriodStatus): boolean {
  return status === "Open" || status === "Closed"
}

/** Re-opening only makes sense for a sealed (Closed/Locked) period. */
export function canRequestReopen(status: PeriodStatus): boolean {
  return status === "Closed" || status === "Locked"
}

/** Postings are blocked whenever a period is not Open. */
export function isPostingBlockedStatus(status: PeriodStatus): boolean {
  return status !== "Open"
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let schemaEnsured = false
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return
  await query(`CREATE TABLE IF NOT EXISTS fiscal_years (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL DEFAULT 0,
    entity_id     INT UNSIGNED NOT NULL DEFAULT 0,
    name          VARCHAR(60) NOT NULL,
    start_date    DATE NOT NULL,
    end_date      DATE NOT NULL,
    status        VARCHAR(10) NOT NULL DEFAULT 'Open',
    created_by    INT UNSIGNED DEFAULT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    closed_by     INT UNSIGNED DEFAULT NULL,
    closed_at     DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_fy (tenant_id, entity_id, name),
    KEY idx_fy_tenant (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS fiscal_periods (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id      INT UNSIGNED NOT NULL DEFAULT 0,
    fiscal_year_id BIGINT UNSIGNED NOT NULL,
    seq            INT NOT NULL,
    name           VARCHAR(30) NOT NULL,
    period_key     VARCHAR(7) NOT NULL,
    start_date     DATE NOT NULL,
    end_date       DATE NOT NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'Open',
    closed_by      INT UNSIGNED DEFAULT NULL,
    closed_at      DATETIME DEFAULT NULL,
    locked_by      INT UNSIGNED DEFAULT NULL,
    locked_at      DATETIME DEFAULT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_fp_year (fiscal_year_id),
    KEY idx_fp_tenant_key (tenant_id, period_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS fiscal_period_reopen_requests (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     INT UNSIGNED NOT NULL DEFAULT 0,
    period_id     BIGINT UNSIGNED NOT NULL,
    reason        VARCHAR(500) DEFAULT NULL,
    status        VARCHAR(10) NOT NULL DEFAULT 'Pending',
    requested_by  INT UNSIGNED DEFAULT NULL,
    requested_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by    INT UNSIGNED DEFAULT NULL,
    decided_at    DATETIME DEFAULT NULL,
    decision_note VARCHAR(500) DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_rr_period (period_id),
    KEY idx_rr_tenant_status (tenant_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  schemaEnsured = true
}

function currentTenantId(): number {
  return getCurrentTenant()?.tenantId ?? 0
}

// ---------------------------------------------------------------------------
// Types returned to the API / UI
// ---------------------------------------------------------------------------

export type FiscalPeriod = {
  id: number
  fiscal_year_id: number
  seq: number
  name: string
  period_key: string
  start_date: string
  end_date: string
  status: PeriodStatus
  closed_at: string | null
  locked_at: string | null
  reopen_request?: ReopenRequest | null
}

export type FiscalYear = {
  id: number
  entity_id: number
  name: string
  start_date: string
  end_date: string
  status: YearStatus
  created_at: string
  closed_at: string | null
  periods: FiscalPeriod[]
}

export type ReopenRequest = {
  id: number
  period_id: number
  period_name?: string
  fiscal_year_name?: string
  reason: string | null
  status: ReopenStatus
  requested_by: number | null
  requested_at: string
  decided_by: number | null
  decided_at: string | null
  decision_note: string | null
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List all fiscal years (with their periods) for the current tenant. */
export async function listFiscalYears(): Promise<FiscalYear[]> {
  await ensureSchema()
  const tenantId = currentTenantId()

  const years = (await query(
    `SELECT id, entity_id, name, start_date, end_date, status, created_at, closed_at
       FROM fiscal_years WHERE tenant_id = ? ORDER BY start_date DESC`,
    [tenantId],
  )) as any[]
  if (years.length === 0) return []

  const yearIds = years.map((y) => y.id)
  const placeholders = yearIds.map(() => "?").join(",")
  const periods = (await query(
    `SELECT id, fiscal_year_id, seq, name, period_key, start_date, end_date, status, closed_at, locked_at
       FROM fiscal_periods
      WHERE tenant_id = ? AND fiscal_year_id IN (${placeholders})
      ORDER BY seq ASC`,
    [tenantId, ...yearIds],
  )) as any[]

  const pending = (await query(
    `SELECT id, period_id, reason, status, requested_by, requested_at, decided_by, decided_at, decision_note
       FROM fiscal_period_reopen_requests
      WHERE tenant_id = ? AND status = 'Pending'`,
    [tenantId],
  )) as any[]
  const pendingByPeriod = new Map<number, ReopenRequest>()
  for (const r of pending) pendingByPeriod.set(Number(r.period_id), mapReopen(r))

  const periodsByYear = new Map<number, FiscalPeriod[]>()
  for (const p of periods) {
    const period: FiscalPeriod = {
      id: Number(p.id),
      fiscal_year_id: Number(p.fiscal_year_id),
      seq: Number(p.seq),
      name: String(p.name),
      period_key: String(p.period_key),
      start_date: fmtDate(p.start_date),
      end_date: fmtDate(p.end_date),
      status: normStatus(p.status),
      closed_at: p.closed_at ? String(p.closed_at) : null,
      locked_at: p.locked_at ? String(p.locked_at) : null,
      reopen_request: pendingByPeriod.get(Number(p.id)) ?? null,
    }
    const arr = periodsByYear.get(period.fiscal_year_id) ?? []
    arr.push(period)
    periodsByYear.set(period.fiscal_year_id, arr)
  }

  return years.map((y) => ({
    id: Number(y.id),
    entity_id: Number(y.entity_id),
    name: String(y.name),
    start_date: fmtDate(y.start_date),
    end_date: fmtDate(y.end_date),
    status: y.status === "Closed" ? "Closed" : "Open",
    created_at: String(y.created_at),
    closed_at: y.closed_at ? String(y.closed_at) : null,
    periods: periodsByYear.get(Number(y.id)) ?? [],
  }))
}

/** List reopen requests (newest first), optionally only the pending ones. */
export async function listReopenRequests(opts: { pendingOnly?: boolean } = {}): Promise<ReopenRequest[]> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const rows = (await query(
    `SELECT rr.id, rr.period_id, rr.reason, rr.status, rr.requested_by, rr.requested_at,
            rr.decided_by, rr.decided_at, rr.decision_note,
            fp.name AS period_name, fy.name AS fiscal_year_name
       FROM fiscal_period_reopen_requests rr
       JOIN fiscal_periods fp ON fp.id = rr.period_id
       JOIN fiscal_years  fy ON fy.id = fp.fiscal_year_id
      WHERE rr.tenant_id = ?
        ${opts.pendingOnly ? "AND rr.status = 'Pending'" : ""}
      ORDER BY rr.requested_at DESC`,
    [tenantId],
  )) as any[]
  return rows.map(mapReopen)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Create a fiscal year and auto-generate its monthly periods. */
export async function createFiscalYear(input: {
  name: string
  startDate: string
  endDate: string
  entityId?: number | null
  userId?: number | null
}): Promise<{ ok: boolean; error?: string; id?: number }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const name = String(input.name ?? "").trim()
  const entityId = Number(input.entityId ?? 0) || 0

  if (!name) return { ok: false, error: "A fiscal year name is required." }
  const periods = generateMonthlyPeriods(input.startDate, input.endDate)
  if (periods.length === 0) {
    return { ok: false, error: "Provide a valid start and end date (end must be on or after start)." }
  }

  const dup = (await query(
    `SELECT id FROM fiscal_years WHERE tenant_id = ? AND entity_id = ? AND name = ? LIMIT 1`,
    [tenantId, entityId, name],
  )) as any[]
  if (dup.length > 0) return { ok: false, error: `A fiscal year named "${name}" already exists for this entity.` }

  const start = periods[0].startDate
  const end = periods[periods.length - 1].endDate
  const res = (await query(
    `INSERT INTO fiscal_years (tenant_id, entity_id, name, start_date, end_date, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'Open', ?)`,
    [tenantId, entityId, name, start, end, input.userId ?? null],
  )) as any
  const yearId = Number(res.insertId)

  for (const p of periods) {
    await query(
      `INSERT INTO fiscal_periods
         (tenant_id, fiscal_year_id, seq, name, period_key, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Open')`,
      [tenantId, yearId, p.seq, p.name, p.periodKey, p.startDate, p.endDate],
    )
  }

  return { ok: true, id: yearId }
}

/** Delete a fiscal year and its periods / reopen requests. */
export async function deleteFiscalYear(yearId: number): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const rows = (await query(
    `SELECT id FROM fiscal_years WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [yearId, tenantId],
  )) as any[]
  if (rows.length === 0) return { ok: false, error: "Fiscal year not found." }

  const periodIds = (await query(
    `SELECT id FROM fiscal_periods WHERE fiscal_year_id = ? AND tenant_id = ?`,
    [yearId, tenantId],
  )) as any[]
  if (periodIds.length > 0) {
    const ph = periodIds.map(() => "?").join(",")
    await query(
      `DELETE FROM fiscal_period_reopen_requests WHERE tenant_id = ? AND period_id IN (${ph})`,
      [tenantId, ...periodIds.map((p) => p.id)],
    )
  }
  await query(`DELETE FROM fiscal_periods WHERE fiscal_year_id = ? AND tenant_id = ?`, [yearId, tenantId])
  await query(`DELETE FROM fiscal_years WHERE id = ? AND tenant_id = ?`, [yearId, tenantId])
  return { ok: true }
}

async function readPeriod(periodId: number, tenantId: number): Promise<any | null> {
  const rows = (await query(
    `SELECT id, fiscal_year_id, name, status FROM fiscal_periods WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [periodId, tenantId],
  )) as any[]
  return rows[0] ?? null
}

/** Soft-close a period (books signed off). Blocks further postings. */
export async function closePeriod(
  periodId: number,
  opts: { userId?: number | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const p = await readPeriod(periodId, tenantId)
  if (!p) return { ok: false, error: "Period not found." }
  if (!canClosePeriod(normStatus(p.status))) {
    return { ok: false, error: `Period "${p.name}" is ${String(p.status).toLowerCase()} and cannot be closed.` }
  }
  await query(
    `UPDATE fiscal_periods SET status = 'Closed', closed_by = ?, closed_at = NOW()
       WHERE id = ? AND tenant_id = ?`,
    [opts.userId ?? null, periodId, tenantId],
  )
  return { ok: true }
}

/** Hard-lock a period (sealed). Blocks further postings. */
export async function lockPeriod(
  periodId: number,
  opts: { userId?: number | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const p = await readPeriod(periodId, tenantId)
  if (!p) return { ok: false, error: "Period not found." }
  if (!canLockPeriod(normStatus(p.status))) {
    return { ok: false, error: `Period "${p.name}" is already locked.` }
  }
  await query(
    `UPDATE fiscal_periods SET status = 'Locked', locked_by = ?, locked_at = NOW()
       WHERE id = ? AND tenant_id = ?`,
    [opts.userId ?? null, periodId, tenantId],
  )
  return { ok: true }
}

/** Close every open period in a year and mark the year Closed. */
export async function closeFiscalYear(
  yearId: number,
  opts: { userId?: number | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const rows = (await query(
    `SELECT id FROM fiscal_years WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [yearId, tenantId],
  )) as any[]
  if (rows.length === 0) return { ok: false, error: "Fiscal year not found." }
  await query(
    `UPDATE fiscal_periods SET status = 'Closed', closed_by = ?, closed_at = NOW()
       WHERE fiscal_year_id = ? AND tenant_id = ? AND status = 'Open'`,
    [opts.userId ?? null, yearId, tenantId],
  )
  await query(
    `UPDATE fiscal_years SET status = 'Closed', closed_by = ?, closed_at = NOW()
       WHERE id = ? AND tenant_id = ?`,
    [opts.userId ?? null, yearId, tenantId],
  )
  return { ok: true }
}

/**
 * File a reopen request for a sealed period. Only one Pending request may exist
 * per period at a time.
 */
export async function requestReopen(
  periodId: number,
  opts: { reason?: string | null; userId?: number | null } = {},
): Promise<{ ok: boolean; error?: string; id?: number }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const p = await readPeriod(periodId, tenantId)
  if (!p) return { ok: false, error: "Period not found." }
  if (!canRequestReopen(normStatus(p.status))) {
    return { ok: false, error: `Period "${p.name}" is open — there is nothing to reopen.` }
  }
  const existing = (await query(
    `SELECT id FROM fiscal_period_reopen_requests WHERE tenant_id = ? AND period_id = ? AND status = 'Pending' LIMIT 1`,
    [tenantId, periodId],
  )) as any[]
  if (existing.length > 0) {
    return { ok: false, error: "A reopen request for this period is already pending approval." }
  }
  const res = (await query(
    `INSERT INTO fiscal_period_reopen_requests (tenant_id, period_id, reason, status, requested_by)
       VALUES (?, ?, ?, 'Pending', ?)`,
    [tenantId, periodId, opts.reason ?? null, opts.userId ?? null],
  )) as any
  return { ok: true, id: Number(res.insertId) }
}

/** Approve a pending reopen request: returns the period to Open. */
export async function approveReopen(
  requestId: number,
  opts: { userId?: number | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const rows = (await query(
    `SELECT id, period_id, status FROM fiscal_period_reopen_requests WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [requestId, tenantId],
  )) as any[]
  const req = rows[0]
  if (!req) return { ok: false, error: "Reopen request not found." }
  if (String(req.status) !== "Pending") return { ok: false, error: "This request has already been decided." }

  await query(
    `UPDATE fiscal_period_reopen_requests
        SET status = 'Approved', decided_by = ?, decided_at = NOW()
      WHERE id = ? AND tenant_id = ?`,
    [opts.userId ?? null, requestId, tenantId],
  )
  await query(
    `UPDATE fiscal_periods
        SET status = 'Open', closed_by = NULL, closed_at = NULL, locked_by = NULL, locked_at = NULL
      WHERE id = ? AND tenant_id = ?`,
    [req.period_id, tenantId],
  )
  // Re-opening a period re-opens its fiscal year too (it is no longer fully closed).
  await query(
    `UPDATE fiscal_years fy
       JOIN fiscal_periods fp ON fp.fiscal_year_id = fy.id
        SET fy.status = 'Open', fy.closed_by = NULL, fy.closed_at = NULL
      WHERE fp.id = ? AND fy.tenant_id = ?`,
    [req.period_id, tenantId],
  )
  return { ok: true }
}

/** Reject a pending reopen request: the period stays sealed. */
export async function rejectReopen(
  requestId: number,
  opts: { userId?: number | null; note?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema()
  const tenantId = currentTenantId()
  const rows = (await query(
    `SELECT id, status FROM fiscal_period_reopen_requests WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [requestId, tenantId],
  )) as any[]
  const req = rows[0]
  if (!req) return { ok: false, error: "Reopen request not found." }
  if (String(req.status) !== "Pending") return { ok: false, error: "This request has already been decided." }
  await query(
    `UPDATE fiscal_period_reopen_requests
        SET status = 'Rejected', decided_by = ?, decided_at = NOW(), decision_note = ?
      WHERE id = ? AND tenant_id = ?`,
    [opts.userId ?? null, opts.note ?? null, requestId, tenantId],
  )
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Finance integration (consulted by lib/finance-period-lock.ts)
// ---------------------------------------------------------------------------

/**
 * True when the given `YYYY-MM` period key falls in a fiscal period that has
 * been Closed or Locked for the current tenant. This is how the Fiscal Year
 * Engine feeds the shared posting guard (`assertPeriodOpen`), so closing or
 * locking a period here blocks back-dated postings everywhere in Finance.
 */
export async function isFiscalPeriodClosedOrLocked(periodKey: string): Promise<boolean> {
  const key = String(periodKey ?? "").trim()
  if (!/^\d{4}-\d{2}$/.test(key)) return false
  await ensureSchema()
  const tenantId = currentTenantId()
  const rows = (await query(
    `SELECT 1 FROM fiscal_periods
      WHERE tenant_id = ? AND period_key = ? AND status IN ('Closed', 'Locked')
      LIMIT 1`,
    [tenantId, key],
  )) as any[]
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Small mapping helpers
// ---------------------------------------------------------------------------

function normStatus(v: any): PeriodStatus {
  const s = String(v)
  return s === "Closed" || s === "Locked" ? s : "Open"
}

function fmtDate(v: any): string {
  if (!v) return ""
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

function mapReopen(r: any): ReopenRequest {
  return {
    id: Number(r.id),
    period_id: Number(r.period_id),
    period_name: r.period_name ? String(r.period_name) : undefined,
    fiscal_year_name: r.fiscal_year_name ? String(r.fiscal_year_name) : undefined,
    reason: r.reason ? String(r.reason) : null,
    status: (["Pending", "Approved", "Rejected"].includes(String(r.status)) ? r.status : "Pending") as ReopenStatus,
    requested_by: r.requested_by != null ? Number(r.requested_by) : null,
    requested_at: String(r.requested_at),
    decided_by: r.decided_by != null ? Number(r.decided_by) : null,
    decided_at: r.decided_at ? String(r.decided_at) : null,
    decision_note: r.decision_note ? String(r.decision_note) : null,
  }
}
