import "server-only"

/**
 * Spec31 (#174-175) — Customer success & product analytics persistence.
 * ---------------------------------------------------------------------------
 * Reuses existing subsystems as READ-ONLY signal sources instead of duplicating
 * them:
 *  - errors  → `system_logs` (System Monitoring)
 *  - jobs    → `platform_background_jobs` (Background jobs / Job monitoring)
 *  - billing → `tenant_subscriptions`, `platform_invoices` (Platform console)
 *  - support → `platform_support_tickets` (Spec28 support SLA)
 *  - seats   → `users`
 * It owns only the privacy-aware usage-event stream, its daily rollup, tenant
 * opt-out/retention settings, per-user opt-outs and daily health snapshots.
 *
 * Every statement carries an explicit `tenant_id = ?` taken from the caller
 * (always server-derived from the session or a platform guard), never from
 * request bodies.
 */

import { query, withTransaction } from "@/lib/db"
import {
  DEFAULT_SETTINGS,
  ROLLUP_RETENTION_DAYS,
  actorHash,
  computeHealth,
  computeTrend,
  dedupKey,
  escapeLike,
  retentionCutoff,
  toSqlDate,
  toSqlDateTime,
  type BillingStatus,
  type ChurnRisk,
  type CsSettings,
  type HealthBand,
  type HealthFactor,
  type HealthSignals,
  type NormalizedEvent,
  type TenantHealthFilter,
  type Trend,
} from "@/lib/customer-success/model"

type Conn = { query: (sql: string, params?: any[]) => Promise<any> }
const DAY = 86_400_000

export function analyticsSecret(): string {
  return process.env.ANALYTICS_HASH_SECRET || process.env.SESSION_SECRET || ""
}

let ensured: Promise<void> | null = null
export function ensureCustomerSuccessSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

async function runEnsure(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS \`cs_usage_events\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`actor_hash\` CHAR(32) NOT NULL,
    \`module\` VARCHAR(40) NOT NULL,
    \`feature\` VARCHAR(64) NOT NULL,
    \`action\` VARCHAR(16) NOT NULL,
    \`dedup_key\` CHAR(64) NOT NULL,
    \`occurred_at\` DATETIME NOT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_cs_event_dedup\` (\`tenant_id\`, \`dedup_key\`),
    KEY \`idx_cs_event_tenant_time\` (\`tenant_id\`, \`occurred_at\`),
    KEY \`idx_cs_event_actor\` (\`tenant_id\`, \`actor_hash\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`cs_usage_daily\` (
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`day\` DATE NOT NULL,
    \`module\` VARCHAR(40) NOT NULL,
    \`feature\` VARCHAR(64) NOT NULL,
    \`action\` VARCHAR(16) NOT NULL,
    \`events\` INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (\`tenant_id\`, \`day\`, \`module\`, \`feature\`, \`action\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`cs_tenant_settings\` (
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`analytics_opt_out\` TINYINT(1) NOT NULL DEFAULT 0,
    \`retention_days\` SMALLINT UNSIGNED NOT NULL DEFAULT 180,
    \`updated_by\` INT UNSIGNED DEFAULT NULL,
    \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`tenant_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`cs_user_opt_outs\` (
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`user_id\` INT UNSIGNED NOT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`tenant_id\`, \`user_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`cs_health_snapshots\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`snapshot_date\` DATE NOT NULL,
    \`score\` TINYINT UNSIGNED NOT NULL,
    \`band\` VARCHAR(12) NOT NULL,
    \`risk_count\` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    \`factors\` JSON NOT NULL,
    \`risks\` JSON NOT NULL,
    \`signals\` JSON NOT NULL,
    \`computed_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_cs_snapshot_day\` (\`tenant_id\`, \`snapshot_date\`),
    KEY \`idx_cs_snapshot_band\` (\`snapshot_date\`, \`band\`, \`score\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

const first = <T = any>(rows: any): T | undefined => (Array.isArray(rows) ? rows[0] : undefined)
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0)
const isMissingTable = (err: unknown) => (err as { code?: string })?.code === "ER_NO_SUCH_TABLE"

/** A signal source whose table has never been created on this install contributes "no evidence". */
async function safeRow(sql: string, params: any[]): Promise<Record<string, unknown> | undefined> {
  try {
    return first(await query<any[]>(sql, params))
  } catch (err) {
    if (isMissingTable(err)) return undefined
    throw err
  }
}

// ---------------------------------------------------------------------------
// Settings & opt-out
// ---------------------------------------------------------------------------
export async function getSettings(tenantId: number): Promise<CsSettings> {
  await ensureCustomerSuccessSchema()
  const row = first(await query<any[]>("SELECT analytics_opt_out, retention_days FROM cs_tenant_settings WHERE tenant_id = ?", [tenantId]))
  if (!row) return { ...DEFAULT_SETTINGS }
  return { analyticsOptOut: Boolean(Number(row.analytics_opt_out)), retentionDays: Number(row.retention_days) }
}

/**
 * Upsert tenant settings. Opting out immediately erases the tenant's raw
 * (pseudonymous) events; anonymous daily counts are kept for trend continuity.
 * Shortening retention purges now rather than waiting for the nightly sweep.
 */
export async function updateSettings(
  tenantId: number,
  patch: Partial<CsSettings>,
  actorUserId: number,
): Promise<{ before: CsSettings; settings: CsSettings; changed: boolean; purgedEvents: number }> {
  const before = await getSettings(tenantId)
  const settings: CsSettings = { ...before, ...patch }
  const changed = settings.analyticsOptOut !== before.analyticsOptOut || settings.retentionDays !== before.retentionDays
  if (!changed) return { before, settings, changed, purgedEvents: 0 }
  await query(
    `INSERT INTO cs_tenant_settings (tenant_id, analytics_opt_out, retention_days, updated_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE analytics_opt_out = VALUES(analytics_opt_out), retention_days = VALUES(retention_days), updated_by = VALUES(updated_by)`,
    [tenantId, settings.analyticsOptOut ? 1 : 0, settings.retentionDays, actorUserId],
  )
  let purgedEvents = 0
  if (settings.analyticsOptOut && !before.analyticsOptOut) {
    const r: any = await query("DELETE FROM cs_usage_events WHERE tenant_id = ?", [tenantId])
    purgedEvents = num(r?.affectedRows)
  } else if (settings.retentionDays < before.retentionDays) {
    purgedEvents = await purgeExpiredEvents(tenantId, settings.retentionDays, new Date())
  }
  return { before, settings, changed, purgedEvents }
}

export async function isUserOptedOut(tenantId: number, userId: number): Promise<boolean> {
  await ensureCustomerSuccessSchema()
  return Boolean(first(await query<any[]>("SELECT 1 AS x FROM cs_user_opt_outs WHERE tenant_id = ? AND user_id = ?", [tenantId, userId])))
}

/** Per-user opt-out. Opting out also erases that user's raw events. */
export async function setUserOptOut(tenantId: number, userId: number, optOut: boolean): Promise<{ changed: boolean; purgedEvents: number }> {
  await ensureCustomerSuccessSchema()
  if (optOut) {
    const r: any = await query("INSERT INTO cs_user_opt_outs (tenant_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id", [tenantId, userId])
    if (num(r?.affectedRows) !== 1) return { changed: false, purgedEvents: 0 }
    const d: any = await query("DELETE FROM cs_usage_events WHERE tenant_id = ? AND actor_hash = ?", [tenantId, actorHash(analyticsSecret(), tenantId, userId)])
    return { changed: true, purgedEvents: num(d?.affectedRows) }
  }
  const r: any = await query("DELETE FROM cs_user_opt_outs WHERE tenant_id = ? AND user_id = ?", [tenantId, userId])
  return { changed: num(r?.affectedRows) > 0, purgedEvents: 0 }
}

// ---------------------------------------------------------------------------
// Event ingestion (deduplicated)
// ---------------------------------------------------------------------------
export type DropReason = "tenant_opt_out" | "user_opt_out" | "impersonation"
export type IngestResult = { accepted: number; duplicates: number; dropped: number; reason: DropReason | null }

export async function recordUsageEvents(input: {
  tenantId: number
  userId: number
  events: NormalizedEvent[]
}): Promise<IngestResult> {
  const { tenantId, userId, events } = input
  const settings = await getSettings(tenantId)
  if (settings.analyticsOptOut) return { accepted: 0, duplicates: 0, dropped: events.length, reason: "tenant_opt_out" }
  if (await isUserOptedOut(tenantId, userId)) return { accepted: 0, duplicates: 0, dropped: events.length, reason: "user_opt_out" }
  const actor = actorHash(analyticsSecret(), tenantId, userId)

  return withTransaction(async (conn: Conn) => {
    let accepted = 0
    let duplicates = 0
    const seen = new Set<string>()
    for (const e of events) {
      const key = dedupKey(tenantId, actor, e)
      if (seen.has(key)) {
        duplicates++
        continue
      }
      seen.add(key)
      const [res] = await conn.query(
        `INSERT INTO cs_usage_events (tenant_id, actor_hash, module, feature, action, dedup_key, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
        [tenantId, actor, e.module, e.feature, e.action, key, toSqlDateTime(e.occurredAt)],
      )
      if (num(res?.affectedRows) !== 1) {
        duplicates++
        continue
      }
      accepted++
      await conn.query(
        `INSERT INTO cs_usage_daily (tenant_id, day, module, feature, action, events) VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE events = events + 1`,
        [tenantId, toSqlDate(e.occurredAt), e.module, e.feature, e.action],
      )
    }
    return { accepted, duplicates, dropped: 0, reason: null }
  })
}

/** Retention: raw events beyond the tenant window; anonymous rollups beyond 2 years. */
export async function purgeExpiredEvents(tenantId: number, retentionDays: number, now: Date): Promise<number> {
  await ensureCustomerSuccessSchema()
  const r: any = await query("DELETE FROM cs_usage_events WHERE tenant_id = ? AND occurred_at < ?", [tenantId, toSqlDateTime(retentionCutoff(retentionDays, now))])
  await query("DELETE FROM cs_usage_daily WHERE tenant_id = ? AND day < ?", [tenantId, toSqlDate(retentionCutoff(ROLLUP_RETENTION_DAYS, now))])
  return num(r?.affectedRows)
}

// ---------------------------------------------------------------------------
// Signals → health snapshot
// ---------------------------------------------------------------------------
export async function collectSignals(tenantId: number, now: Date): Promise<HealthSignals> {
  await ensureCustomerSuccessSchema()
  const d7 = toSqlDateTime(new Date(now.getTime() - 7 * DAY))
  const d30 = toSqlDateTime(new Date(now.getTime() - 30 * DAY))
  const day30 = toSqlDate(new Date(now.getTime() - 30 * DAY))
  const day60 = toSqlDate(new Date(now.getTime() - 60 * DAY))
  const settings = await getSettings(tenantId)

  const [active, seats, modules, volume, errors, jobs, sub, overdue, support] = await Promise.all([
    safeRow("SELECT COUNT(DISTINCT actor_hash) AS c FROM cs_usage_events WHERE tenant_id = ? AND occurred_at >= ?", [tenantId, d30]),
    safeRow("SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND status = 'active'", [tenantId]),
    safeRow("SELECT COUNT(DISTINCT module) AS c FROM cs_usage_daily WHERE tenant_id = ? AND day >= ?", [tenantId, day30]),
    safeRow(
      "SELECT SUM(CASE WHEN day >= ? THEN events ELSE 0 END) AS cur, SUM(CASE WHEN day < ? THEN events ELSE 0 END) AS prev FROM cs_usage_daily WHERE tenant_id = ? AND day >= ?",
      [day30, day30, tenantId, day60],
    ),
    safeRow(
      "SELECT SUM(severity IN ('error','critical','fatal')) AS errors, SUM(severity IN ('critical','fatal')) AS critical FROM system_logs WHERE tenant_id = ? AND created_at >= ?",
      [tenantId, d7],
    ),
    safeRow(
      "SELECT COUNT(*) AS total, SUM(status IN ('failed','dead_letter')) AS failed FROM platform_background_jobs WHERE tenant_id = ? AND created_at >= ?",
      [tenantId, d7],
    ),
    safeRow("SELECT status FROM tenant_subscriptions WHERE tenant_id = ? LIMIT 1", [tenantId]),
    safeRow("SELECT COUNT(*) AS c FROM platform_invoices WHERE tenant_id = ? AND status = 'open' AND issued_at < ?", [tenantId, day30]),
    safeRow(
      `SELECT SUM(status NOT IN ('resolved','closed')) AS open_count,
              SUM(status NOT IN ('resolved','closed') AND priority IN ('high','urgent')) AS urgent_open,
              SUM(created_at >= ? AND (response_breached = 1 OR resolution_breached = 1)) AS breached
         FROM platform_support_tickets WHERE tenant_id = ?`,
      [d30, tenantId],
    ),
  ])

  const status = String(sub?.status ?? "none")
  const billingStatus: BillingStatus = (["trialing", "active", "past_due", "canceled"] as const).includes(status as any) ? (status as BillingStatus) : "none"
  return {
    adoption: {
      available: !settings.analyticsOptOut,
      activeUsers30d: num(active?.c),
      seats: num(seats?.c),
      modulesUsed30d: num(modules?.c),
      events30d: num(volume?.cur),
      eventsPrev30d: num(volume?.prev),
    },
    errors: { errors7d: num(errors?.errors), critical7d: num(errors?.critical) },
    jobs: { total7d: num(jobs?.total), failed7d: num(jobs?.failed) },
    billing: { status: billingStatus, overdueInvoices: num(overdue?.c) },
    support: { open: num(support?.open_count), urgentOpen: num(support?.urgent_open), breached30d: num(support?.breached) },
  }
}

export type HealthSnapshot = {
  tenantId: number
  date: string
  score: number
  band: HealthBand
  factors: HealthFactor[]
  risks: ChurnRisk[]
  signals: HealthSignals
}

/** Compute and upsert today's snapshot. Re-running on the same day replaces it (idempotent). */
export async function computeSnapshot(tenantId: number, now = new Date()): Promise<HealthSnapshot> {
  const signals = await collectSignals(tenantId, now)
  const health = computeHealth(signals)
  const date = toSqlDate(now)
  await query(
    `INSERT INTO cs_health_snapshots (tenant_id, snapshot_date, score, band, risk_count, factors, risks, signals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE score = VALUES(score), band = VALUES(band), risk_count = VALUES(risk_count),
       factors = VALUES(factors), risks = VALUES(risks), signals = VALUES(signals)`,
    [tenantId, date, health.score, health.band, health.risks.length, JSON.stringify(health.factors), JSON.stringify(health.risks), JSON.stringify(signals)],
  )
  return { tenantId, date, ...health, signals }
}

const parseJson = <T,>(v: unknown, fallback: T): T => {
  if (v == null) return fallback
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T
    } catch {
      return fallback
    }
  }
  return v as T
}

function toSnapshot(row: any): HealthSnapshot {
  return {
    tenantId: Number(row.tenant_id),
    date: typeof row.snapshot_date === "string" ? row.snapshot_date.slice(0, 10) : toSqlDate(new Date(row.snapshot_date)),
    score: Number(row.score),
    band: row.band as HealthBand,
    factors: parseJson(row.factors, []),
    risks: parseJson(row.risks, []),
    signals: parseJson(row.signals, {} as HealthSignals),
  }
}

export type ModuleUsage = { module: string; feature: string; events: number }
export type TenantHealthDetail = {
  snapshot: HealthSnapshot
  trend: Trend
  modules: ModuleUsage[]
  settings: CsSettings
}

/** Full health view for ONE tenant. Computes today's snapshot on first read of the day. */
export async function getTenantHealth(tenantId: number, opts: { trendDays?: number; now?: Date } = {}): Promise<TenantHealthDetail> {
  await ensureCustomerSuccessSchema()
  const now = opts.now ?? new Date()
  const trendDays = Math.max(7, Math.min(180, opts.trendDays ?? 90))
  const today = toSqlDate(now)
  const existing = first(await query<any[]>("SELECT * FROM cs_health_snapshots WHERE tenant_id = ? AND snapshot_date = ?", [tenantId, today]))
  const snapshot = existing ? toSnapshot(existing) : await computeSnapshot(tenantId, now)
  const history = await query<any[]>(
    "SELECT snapshot_date, score FROM cs_health_snapshots WHERE tenant_id = ? AND snapshot_date >= ? ORDER BY snapshot_date ASC",
    [tenantId, toSqlDate(new Date(now.getTime() - trendDays * DAY))],
  )
  const modules = await query<any[]>(
    `SELECT module, feature, SUM(events) AS events FROM cs_usage_daily WHERE tenant_id = ? AND day >= ?
     GROUP BY module, feature ORDER BY events DESC LIMIT 20`,
    [tenantId, toSqlDate(new Date(now.getTime() - 30 * DAY))],
  )
  return {
    snapshot,
    trend: computeTrend((history ?? []).map((r) => toSnapshot({ ...r, tenant_id: tenantId, band: "", factors: null, risks: null, signals: null })).map((s) => ({ date: s.date, score: s.score }))),
    modules: (modules ?? []).map((r) => ({ module: String(r.module), feature: String(r.feature), events: num(r.events) })),
    settings: await getSettings(tenantId),
  }
}

export type TenantHealthRow = {
  tenantId: number
  name: string
  plan: string
  status: string
  score: number | null
  band: HealthBand | null
  riskCount: number
  snapshotDate: string | null
}

/** Platform list: latest snapshot per tenant, filtered server-side. */
export async function listTenantHealth(filter: TenantHealthFilter): Promise<{ rows: TenantHealthRow[]; total: number }> {
  await ensureCustomerSuccessSchema()
  const where: string[] = []
  const params: any[] = []
  if (filter.q) {
    where.push("t.name LIKE ?")
    params.push(`%${escapeLike(filter.q)}%`)
  }
  if (filter.plan) {
    where.push("t.plan = ?")
    params.push(filter.plan)
  }
  if (filter.band) {
    where.push("s.band = ?")
    params.push(filter.band)
  }
  if (filter.atRiskOnly) where.push("s.risk_count > 0")
  const from = `FROM tenants t
    LEFT JOIN cs_health_snapshots s ON s.tenant_id = t.id
      AND s.snapshot_date = (SELECT MAX(x.snapshot_date) FROM cs_health_snapshots x WHERE x.tenant_id = t.id)
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`
  const total = num(first(await query<any[]>(`SELECT COUNT(*) AS c ${from}`, params))?.c)
  const rows = await query<any[]>(
    `SELECT t.id AS tenant_id, t.name, t.plan, t.status, s.score, s.band, s.risk_count, s.snapshot_date ${from}
     ORDER BY s.score IS NULL, s.score ASC, t.id ASC LIMIT ? OFFSET ?`,
    [...params, filter.pageSize, (filter.page - 1) * filter.pageSize],
  )
  return {
    total,
    rows: (rows ?? []).map((r) => ({
      tenantId: Number(r.tenant_id),
      name: String(r.name),
      plan: String(r.plan ?? ""),
      status: String(r.status ?? ""),
      score: r.score == null ? null : Number(r.score),
      band: (r.band as HealthBand) ?? null,
      riskCount: num(r.risk_count),
      snapshotDate: r.snapshot_date == null ? null : String(typeof r.snapshot_date === "string" ? r.snapshot_date : toSqlDate(new Date(r.snapshot_date))).slice(0, 10),
    })),
  }
}

export async function tenantExists(tenantId: number): Promise<boolean> {
  return Boolean(first(await query<any[]>("SELECT id FROM tenants WHERE id = ? LIMIT 1", [tenantId])))
}

/** Nightly: per-tenant retention purge + snapshot. One tenant's failure never stops the sweep. */
export async function sweepAllTenants(now = new Date()): Promise<{ tenants: number; snapshots: number; purged: number; failed: number }> {
  await ensureCustomerSuccessSchema()
  const tenants = await query<any[]>("SELECT id FROM tenants WHERE status = 'active' ORDER BY id")
  let snapshots = 0
  let purged = 0
  let failed = 0
  for (const t of tenants ?? []) {
    const tenantId = Number(t.id)
    try {
      const settings = await getSettings(tenantId)
      purged += await purgeExpiredEvents(tenantId, settings.retentionDays, now)
      await computeSnapshot(tenantId, now)
      snapshots++
    } catch (err) {
      failed++
      console.error("[customer-success] sweep failed for tenant", tenantId, (err as Error)?.message)
    }
  }
  return { tenants: (tenants ?? []).length, snapshots, purged, failed }
}
