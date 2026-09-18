import "server-only"
/**
 * SPEC 19 — Usage Metering (per-tenant).
 * ---------------------------------------------------------------------------
 * Tracks how much of each measurable resource a tenant consumes so the product
 * can power usage-based billing, quotas and capacity reports.
 *
 * Phase 1 — measurable resources: the METER_CATALOG below enumerates every
 *   resource we know how to count. Each meter is either:
 *     - "counter": event-driven, cumulative over a period. Recorded through
 *       recordUsage() from anywhere in the app (API middleware, cron jobs, the
 *       AI layer, the mailer, …) and aggregated in usage_events / usage_daily.
 *     - "gauge": a point-in-time count derived live from the tenant's own data
 *       (e.g. how many employees exist right now). No events needed — computed
 *       on read from the real source tables, degrading to 0 when a source table
 *       is not present in this deployment.
 *
 * Phase 2 — infrastructure: three tenant-scoped tables (registered in
 *   lib/tenant-tables.ts so the isolation guard protects them):
 *     - usage_events : append-only event log (audit + re-aggregation source).
 *     - usage_daily  : per-tenant/meter/day rollup for fast reporting.
 *     - usage_limits : per-tenant/meter quota configuration.
 *
 * Phase 3 — integration: recordUsage() is the single ingestion point. It is
 *   tenant-scoped (never trusts client tenant input) and fire-and-forget safe.
 *
 * Phase 4 — reports & limits: getUsageOverview() returns each meter's usage for
 *   the current period against its configured limit with an ok/warning/over
 *   status; checkUsageLimit() lets callers enforce a hard quota before allowing
 *   a metered action.
 */
import { query, tableColumns } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"

export type MeterKind = "counter" | "gauge"
export type MeterCategory = "activity" | "storage" | "communication" | "compute" | "ai"
export type LimitPeriod = "month" | "day" | "none"

export type MeterDef = {
  key: string
  label: string
  description: string
  unit: string
  kind: MeterKind
  category: MeterCategory
  /** Display decimals; counters measuring bytes-as-GB want 2, counts want 0. */
  decimals: number
}

/** Phase 1 — the catalog of measurable resources tracked per tenant. */
export const METER_CATALOG: MeterDef[] = [
  {
    key: "active_users",
    label: "Active users",
    description: "User accounts currently active in this organisation.",
    unit: "users",
    kind: "gauge",
    category: "activity",
    decimals: 0,
  },
  {
    key: "employees",
    label: "Employees",
    description: "Employee records managed in the workspace.",
    unit: "employees",
    kind: "gauge",
    category: "activity",
    decimals: 0,
  },
  {
    key: "documents",
    label: "Documents",
    description: "Stored documents and file attachments.",
    unit: "documents",
    kind: "gauge",
    category: "storage",
    decimals: 0,
  },
  {
    key: "storage",
    label: "Storage",
    description: "Cumulative object storage consumed.",
    unit: "GB",
    kind: "counter",
    category: "storage",
    decimals: 2,
  },
  {
    key: "video_storage",
    label: "Video storage",
    description: "Storage consumed by uploaded video assets.",
    unit: "GB",
    kind: "counter",
    category: "storage",
    decimals: 2,
  },
  {
    key: "file_bandwidth",
    label: "File bandwidth",
    description: "Outbound bandwidth served for file downloads.",
    unit: "GB",
    kind: "counter",
    category: "storage",
    decimals: 2,
  },
  {
    key: "api_requests",
    label: "API requests",
    description: "Authenticated API calls made against the tenant.",
    unit: "requests",
    kind: "counter",
    category: "compute",
    decimals: 0,
  },
  {
    key: "emails",
    label: "Emails",
    description: "Transactional and campaign emails dispatched.",
    unit: "emails",
    kind: "counter",
    category: "communication",
    decimals: 0,
  },
  {
    key: "notifications",
    label: "Notifications",
    description: "In-app notifications fanned out to users.",
    unit: "notifications",
    kind: "counter",
    category: "communication",
    decimals: 0,
  },
  {
    key: "automation_runs",
    label: "Automation runs",
    description: "Workflow / automation executions triggered.",
    unit: "runs",
    kind: "counter",
    category: "compute",
    decimals: 0,
  },
  {
    key: "background_jobs",
    label: "Background jobs",
    description: "Scheduled and queued background jobs processed.",
    unit: "jobs",
    kind: "counter",
    category: "compute",
    decimals: 0,
  },
  {
    key: "ai_usage",
    label: "AI usage",
    description: "Tokens consumed by AI-powered features.",
    unit: "tokens",
    kind: "counter",
    category: "ai",
    decimals: 0,
  },
]

const METER_BY_KEY = new Map(METER_CATALOG.map((m) => [m.key, m]))

export function getMeter(key: string): MeterDef | undefined {
  return METER_BY_KEY.get(key)
}

export function isMeterKey(key: string): boolean {
  return METER_BY_KEY.has(key)
}

// ---------------------------------------------------------------------------
// Phase 2 — schema (self-healing, mirrors the project's other modules)
// ---------------------------------------------------------------------------

let schemaEnsured = false

export async function ensureUsageSchema(): Promise<void> {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS usage_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      meter_key VARCHAR(60) NOT NULL,
      quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
      unit VARCHAR(20) NOT NULL DEFAULT 'unit',
      source VARCHAR(60) NULL,
      ref_id VARCHAR(80) NULL,
      metadata JSON NULL,
      occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_usage_events_meter (tenant_id, meter_key, occurred_at),
      KEY idx_usage_events_time (tenant_id, occurred_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS usage_daily (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      meter_key VARCHAR(60) NOT NULL,
      usage_date DATE NOT NULL,
      quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
      event_count INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_usage_daily (tenant_id, meter_key, usage_date),
      KEY idx_usage_daily_lookup (tenant_id, meter_key, usage_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS usage_limits (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      meter_key VARCHAR(60) NOT NULL,
      limit_value DECIMAL(18,4) NOT NULL DEFAULT 0,
      period VARCHAR(10) NOT NULL DEFAULT 'month',
      hard_limit TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_usage_limits (tenant_id, meter_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  schemaEnsured = true
}

// ---------------------------------------------------------------------------
// Phase 3 — ingestion
// ---------------------------------------------------------------------------

export type RecordUsageInput = {
  meterKey: string
  quantity?: number
  source?: string | null
  refId?: string | null
  metadata?: Record<string, unknown> | null
  /** Defaults to now. */
  occurredAt?: Date
}

/**
 * Record a metered usage event for the CURRENT tenant and fold it into the
 * daily rollup. Tenant is always derived from session context, never trusted
 * from input. Only "counter" meters can be recorded — gauges are computed live.
 * Returns false (without throwing) on any bad input so callers can treat it as
 * fire-and-forget.
 */
export async function recordUsage(input: RecordUsageInput): Promise<boolean> {
  const meter = METER_BY_KEY.get(input.meterKey)
  if (!meter || meter.kind !== "counter") return false
  const quantity = Number(input.quantity ?? 1)
  if (!Number.isFinite(quantity) || quantity <= 0) return false

  const tenantId = currentTenantId()
  await ensureUsageSchema()

  const occurredAt = input.occurredAt ?? new Date()
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null

  await query(
    `INSERT INTO usage_events (tenant_id, meter_key, quantity, unit, source, ref_id, metadata, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      meter.key,
      quantity,
      meter.unit,
      input.source ?? null,
      input.refId ?? null,
      metadataJson,
      occurredAt,
    ],
  )

  await query(
    `INSERT INTO usage_daily (tenant_id, meter_key, usage_date, quantity, event_count)
     VALUES (?, ?, DATE(?), ?, 1)
     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), event_count = event_count + 1`,
    [tenantId, meter.key, occurredAt, quantity],
  )

  return true
}

/**
 * Fire-and-forget wrapper: never rejects into the caller. Use from hot paths
 * (mailer, notification fan-out, AI calls) where metering must not affect the
 * primary operation.
 */
export function recordUsageSafe(input: RecordUsageInput): void {
  recordUsage(input).catch((err) => {
    console.error("[v0] recordUsage failed:", err)
  })
}

// ---------------------------------------------------------------------------
// Phase 1 (read side) — live gauge resolvers
// ---------------------------------------------------------------------------

/**
 * Count rows in `table` for the current tenant, adapting to what the table
 * actually has: applies a tenant_id filter only when that column exists, and
 * an optional extra predicate only when its column exists. Missing tables
 * resolve to 0 so a gauge degrades gracefully instead of crashing.
 */
async function countTenantRows(
  tenantId: number,
  table: string,
  opts: { column?: string; equals?: string } = {},
): Promise<number> {
  const cols = await tableColumns(table)
  if (cols.size === 0) return 0
  const where: string[] = []
  const params: any[] = []
  if (cols.has("tenant_id")) {
    where.push("tenant_id = ?")
    params.push(tenantId)
  }
  if (opts.column && opts.equals !== undefined && cols.has(opts.column)) {
    where.push(`\`${opts.column}\` = ?`)
    params.push(opts.equals)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const rows = await query<{ n: number }[]>(`SELECT COUNT(*) AS n FROM \`${table}\` ${clause}`, params)
  return Number(rows[0]?.n ?? 0)
}

/** Document-like source tables; the sum of present ones feeds the gauge. */
const DOCUMENT_TABLES = [
  "documents",
  "hr_documents",
  "employee_documents",
  "project_documents",
  "candidate_documents",
]

async function resolveGauge(tenantId: number, meterKey: string): Promise<number> {
  switch (meterKey) {
    case "active_users":
      return countTenantRows(tenantId, "users", { column: "status", equals: "active" })
    case "employees":
      return countTenantRows(tenantId, "employees")
    case "documents": {
      let total = 0
      for (const t of DOCUMENT_TABLES) total += await countTenantRows(tenantId, t)
      return total
    }
    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — reporting & limits
// ---------------------------------------------------------------------------

export type UsageStatus = "ok" | "warning" | "over" | "no_limit"

export type MeterUsage = MeterDef & {
  /** Usage for the active period (month for counters, current value for gauges). */
  used: number
  /** Previous period total (counters only) for trend display. */
  previous: number
  limit: number | null
  limitPeriod: LimitPeriod
  hardLimit: boolean
  percent: number | null
  status: UsageStatus
}

export type UsageTrendPoint = { date: string } & Record<string, number>

export type UsageOverview = {
  periodStart: string
  periodEnd: string
  meters: MeterUsage[]
  trend: UsageTrendPoint[]
  summary: {
    metersTracked: number
    metersWithLimit: number
    metersOverLimit: number
    metersWarning: number
  }
}

function monthBounds(ref = new Date()): { start: Date; end: Date; prevStart: Date } {
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1))
  const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1))
  const prevStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1))
  return { start, end, prevStart }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

type LimitRow = { meter_key: string; limit_value: number; period: string; hard_limit: number; is_active: number }

/** Counter totals for the current tenant grouped by meter within a date range. */
async function counterTotals(
  tenantId: number,
  fromDate: string,
  toDateExclusive: string,
): Promise<Map<string, number>> {
  const rows = await query<{ meter_key: string; total: number }[]>(
    `SELECT meter_key, SUM(quantity) AS total
       FROM usage_daily
      WHERE tenant_id = ? AND usage_date >= ? AND usage_date < ?
      GROUP BY meter_key`,
    [tenantId, fromDate, toDateExclusive],
  )
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.meter_key, Number(r.total ?? 0))
  return map
}

function computeStatus(used: number, limit: number | null): { percent: number | null; status: UsageStatus } {
  if (limit == null || limit <= 0) return { percent: null, status: "no_limit" }
  const percent = (used / limit) * 100
  let status: UsageStatus = "ok"
  if (used >= limit) status = "over"
  else if (percent >= 80) status = "warning"
  return { percent, status }
}

/** Phase 4 — the full usage report for the current tenant. */
export async function getUsageOverview(options: { trendDays?: number } = {}): Promise<UsageOverview> {
  const tenantId = currentTenantId()
  await ensureUsageSchema()

  const now = new Date()
  const { start, end, prevStart } = monthBounds(now)
  const startYmd = ymd(start)
  const endYmd = ymd(end)
  const prevStartYmd = ymd(prevStart)

  const [current, previous, limitRows] = await Promise.all([
    counterTotals(tenantId, startYmd, endYmd),
    counterTotals(tenantId, prevStartYmd, startYmd),
    query<LimitRow[]>(
      `SELECT meter_key, limit_value, period, hard_limit, is_active FROM usage_limits WHERE tenant_id = ?`,
      [tenantId],
    ),
  ])

  const limitByKey = new Map<string, LimitRow>()
  for (const r of limitRows) if (r.is_active) limitByKey.set(r.meter_key, r)

  const meters: MeterUsage[] = []
  for (const meter of METER_CATALOG) {
    const used =
      meter.kind === "gauge"
        ? await resolveGauge(tenantId, meter.key)
        : Number(current.get(meter.key) ?? 0)
    const previousUsed = meter.kind === "gauge" ? used : Number(previous.get(meter.key) ?? 0)

    const limitRow = limitByKey.get(meter.key)
    const limit = limitRow ? Number(limitRow.limit_value) : null
    const limitPeriod = (limitRow?.period as LimitPeriod) ?? "none"
    const hardLimit = Boolean(limitRow?.hard_limit)
    const { percent, status } = computeStatus(used, limit)

    meters.push({
      ...meter,
      used,
      previous: previousUsed,
      limit,
      limitPeriod,
      hardLimit,
      percent,
      status,
    })
  }

  const trend = await getUsageTrend(tenantId, options.trendDays ?? 30)

  const summary = {
    metersTracked: meters.length,
    metersWithLimit: meters.filter((m) => m.limit != null).length,
    metersOverLimit: meters.filter((m) => m.status === "over").length,
    metersWarning: meters.filter((m) => m.status === "warning").length,
  }

  return { periodStart: startYmd, periodEnd: endYmd, meters, trend, summary }
}

/** Daily totals per counter meter for the last `days` days (charting). */
async function getUsageTrend(tenantId: number, days: number): Promise<UsageTrendPoint[]> {
  const span = Math.max(1, Math.min(120, days))
  const from = new Date()
  from.setUTCDate(from.getUTCDate() - (span - 1))
  const fromYmd = ymd(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())))

  const rows = await query<{ usage_date: string; meter_key: string; quantity: number }[]>(
    `SELECT DATE_FORMAT(usage_date, '%Y-%m-%d') AS usage_date, meter_key, quantity
       FROM usage_daily
      WHERE tenant_id = ? AND usage_date >= ?
      ORDER BY usage_date ASC`,
    [tenantId, fromYmd],
  )

  const counterKeys = METER_CATALOG.filter((m) => m.kind === "counter").map((m) => m.key)
  const byDate = new Map<string, UsageTrendPoint>()
  // Seed every day so the chart has a continuous x-axis.
  for (let i = 0; i < span; i++) {
    const d = new Date(from)
    d.setUTCDate(from.getUTCDate() + i)
    const key = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())))
    const point: UsageTrendPoint = { date: key }
    for (const k of counterKeys) point[k] = 0
    byDate.set(key, point)
  }
  for (const r of rows) {
    const point = byDate.get(r.usage_date)
    if (point) point[r.meter_key] = (point[r.meter_key] ?? 0) + Number(r.quantity ?? 0)
  }
  return [...byDate.values()]
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export type LimitInput = {
  meterKey: string
  limitValue: number
  period?: LimitPeriod
  hardLimit?: boolean
  isActive?: boolean
}

/** Create or update a tenant's quota for a meter. */
export async function setUsageLimit(input: LimitInput): Promise<void> {
  if (!isMeterKey(input.meterKey)) throw new Error("Unknown meter")
  const limitValue = Number(input.limitValue)
  if (!Number.isFinite(limitValue) || limitValue < 0) throw new Error("Invalid limit value")
  const period: LimitPeriod = input.period ?? "month"
  const tenantId = currentTenantId()
  await ensureUsageSchema()
  await query(
    `INSERT INTO usage_limits (tenant_id, meter_key, limit_value, period, hard_limit, is_active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       limit_value = VALUES(limit_value),
       period = VALUES(period),
       hard_limit = VALUES(hard_limit),
       is_active = VALUES(is_active)`,
    [
      tenantId,
      input.meterKey,
      limitValue,
      period,
      input.hardLimit ? 1 : 0,
      input.isActive === false ? 0 : 1,
    ],
  )
}

/** Remove a meter's quota for the current tenant. */
export async function clearUsageLimit(meterKey: string): Promise<void> {
  const tenantId = currentTenantId()
  await ensureUsageSchema()
  await query(`DELETE FROM usage_limits WHERE tenant_id = ? AND meter_key = ?`, [tenantId, meterKey])
}

export type LimitCheck = {
  allowed: boolean
  used: number
  limit: number | null
  remaining: number | null
  hardLimit: boolean
  status: UsageStatus
}

/**
 * Check whether the current tenant may consume `amount` more of a meter this
 * period. `allowed` is false only when a HARD limit would be exceeded — soft
 * limits always allow but report an "over"/"warning" status so callers can warn
 * without blocking. Use before performing a metered action to enforce quotas.
 */
export async function checkUsageLimit(meterKey: string, amount = 1): Promise<LimitCheck> {
  const meter = METER_BY_KEY.get(meterKey)
  if (!meter) return { allowed: true, used: 0, limit: null, remaining: null, hardLimit: false, status: "no_limit" }
  const tenantId = currentTenantId()
  await ensureUsageSchema()

  const limitRows = await query<LimitRow[]>(
    `SELECT meter_key, limit_value, period, hard_limit, is_active
       FROM usage_limits WHERE tenant_id = ? AND meter_key = ? LIMIT 1`,
    [tenantId, meterKey],
  )
  const limitRow = limitRows[0]
  if (!limitRow || !limitRow.is_active) {
    return { allowed: true, used: 0, limit: null, remaining: null, hardLimit: false, status: "no_limit" }
  }

  let used: number
  if (meter.kind === "gauge") {
    used = await resolveGauge(tenantId, meterKey)
  } else {
    const { start, end } = monthBounds()
    const totals = await counterTotals(tenantId, ymd(start), ymd(end))
    used = Number(totals.get(meterKey) ?? 0)
  }

  const limit = Number(limitRow.limit_value)
  const hardLimit = Boolean(limitRow.hard_limit)
  const projected = used + Math.max(0, amount)
  const { status } = computeStatus(projected, limit)
  const remaining = limit > 0 ? Math.max(0, limit - used) : null
  const allowed = hardLimit ? projected <= limit : true

  return { allowed, used, limit, remaining, hardLimit, status }
}
