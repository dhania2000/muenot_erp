import "server-only"
/**
 * SPEC 20 (req #75) — tenant-scoped observation collectors.
 * ---------------------------------------------------------------------------
 * The ONLY layer that touches the database on the read side. It reuses the
 * existing finance, security-audit and usage-metering subsystems rather than
 * duplicating them, and hands the detectors (detectors.ts — pure) plain,
 * already-tenant-scoped observation sets.
 *
 * Tenant scope:
 *   - usage_events is a guard-registered tenant-owned table → read through
 *     scopedWhere so every query carries a tenant_id predicate.
 *   - security_audit_events is read through the security subsystem's own
 *     tenant-aware reader (listSecurityEvents(tenantId, …)).
 *   - billing_payments / billing_invoices are guard-registered tenant tables →
 *     read through scopedWhere for EVERY tenant.
 *   - The global ERP finance tables (payments, sales_invoices) carry no
 *     tenant_id by design (see lib/tenant-tables.ts). They belong to the
 *     platform-owner workspace only, so they are read ONLY when the current
 *     tenant is the platform owner. Reading them for any other tenant would
 *     leak one organization's ledger into another's risk queue.
 *
 * Nothing here decides anything — it only shapes data. All thresholds and
 * verdicts live in the pure model/detector layer.
 */
import { query } from "@/lib/db"
import { scopedWhere, currentTenantIdOrNull } from "@/lib/tenant-scope"
import { listPayments } from "@/lib/finance-payments"
import { listSecurityEvents, type SecurityAuditEvent } from "@/lib/security-audit-store"
import type { AmountObservation, SeriesPoint } from "./detectors"

export type AccessEvent = {
  id: string
  actorId: number | null
  actorLabel: string | null
  action: string
  outcome: string
  occurredAt: string | null
  detail: Record<string, unknown> | null
}

export type UsageMeterSeries = {
  meterKey: string
  series: SeriesPoint[]
}

export type CollectedData = {
  windowFrom: string
  windowTo: string
  payments: AmountObservation[]
  paymentSeries: SeriesPoint[]
  invoices: AmountObservation[]
  invoiceSeries: SeriesPoint[]
  accessSeries: SeriesPoint[]
  accessEvents: AccessEvent[]
  usage: UsageMeterSeries[]
}

export type CollectOptions = {
  /** Look-back window in days. */
  windowDays: number
  /** Categories to collect; defaults to all. */
  categories?: readonly ("payment" | "invoice" | "access" | "usage")[]
  /** Injectable clock for deterministic tests. */
  now?: Date
}

const DAY_MS = 24 * 60 * 60 * 1000

function dayKey(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/** Turn dated numeric records into a dense daily series (count or sum). */
function bucketDaily(
  from: Date,
  to: Date,
  rows: { date: string | null; value: number }[],
  mode: "count" | "sum",
): SeriesPoint[] {
  const buckets = new Map<string, number>()
  // Seed every day in the window with 0 so a quiet day counts as a real
  // baseline observation (this is what keeps a spike honest).
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    buckets.set(new Date(t).toISOString().slice(0, 10), 0)
  }
  for (const r of rows) {
    const key = dayKey(r.date)
    if (key == null || !buckets.has(key)) continue
    const prev = buckets.get(key) ?? 0
    buckets.set(key, mode === "count" ? prev + 1 : prev + (Number.isFinite(r.value) ? r.value : 0))
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, value]) => ({ bucket, value }))
}

function wants(opts: CollectOptions, category: "payment" | "invoice" | "access" | "usage"): boolean {
  return !opts.categories || opts.categories.includes(category)
}

/**
 * Collect every observation set for the current tenant. Each sub-collector is
 * defensive: a missing source table or empty history yields empty arrays, never
 * a throw, so one broken source cannot abort the whole scan.
 */
export async function collectObservations(opts: CollectOptions): Promise<CollectedData> {
  const now = opts.now ?? new Date()
  const to = now
  const from = new Date(now.getTime() - opts.windowDays * DAY_MS)
  const fromDate = from.toISOString().slice(0, 10)
  const toDate = to.toISOString().slice(0, 10)

  const includeErpLedger =
    (wants(opts, "payment") || wants(opts, "invoice")) && (await ownsGlobalErpLedger(currentTenantIdOrNull()))

  const [payments, invoices, access, usage] = await Promise.all([
    wants(opts, "payment") ? collectPayments(fromDate, toDate, from, to, includeErpLedger) : emptyMonetary(),
    wants(opts, "invoice") ? collectInvoices(fromDate, toDate, from, to, includeErpLedger) : emptyMonetary(),
    wants(opts, "access") ? collectAccess(from, to) : Promise.resolve({ series: [] as SeriesPoint[], events: [] as AccessEvent[] }),
    wants(opts, "usage") ? collectUsage(fromDate, toDate, from, to) : Promise.resolve([] as UsageMeterSeries[]),
  ])

  return {
    windowFrom: fromDate,
    windowTo: toDate,
    payments: payments.records,
    paymentSeries: payments.series,
    invoices: invoices.records,
    invoiceSeries: invoices.series,
    accessSeries: access.series,
    accessEvents: access.events,
    usage,
  }
}

function emptyMonetary(): Promise<{ records: AmountObservation[]; series: SeriesPoint[] }> {
  return Promise.resolve({ records: [], series: [] })
}

// ---------------------------------------------------------------------------
// Payments — reuse finance-payments.listPayments (global ERP ledger).
// ---------------------------------------------------------------------------

async function collectPayments(
  fromDate: string,
  toDate: string,
  from: Date,
  to: Date,
  includeErpLedger: boolean,
): Promise<{ records: AmountObservation[]; series: SeriesPoint[] }> {
  const records: AmountObservation[] = []
  const dates: { date: string | null; value: number }[] = []

  if (includeErpLedger) {
    try {
      const rows = await listPayments({ from: fromDate, to: toDate })
      const active = rows.filter((r) => String(r.status ?? "").toLowerCase() !== "reversed")
      for (const r of active) {
        records.push({
          id: String(r.payment_id ?? r.id),
          amount: Number(r.amount ?? 0),
          label: r.payment_id ? `Payment ${r.payment_id}` : null,
          occurredAt: r.payment_date ? new Date(r.payment_date).toISOString() : null,
          party: r.party_name ?? null,
        })
        dates.push({ date: r.payment_date ?? null, value: 1 })
      }
    } catch (err) {
      console.error("[v0] anomaly collectPayments (ERP ledger) failed:", err)
    }
  }

  try {
    const { where, params } = scopedWhere(
      "billing_payments",
      "COALESCE(paid_at, created_at) >= ? AND COALESCE(paid_at, created_at) <= ? AND status <> 'failed'",
      [`${fromDate} 00:00:00`, `${toDate} 23:59:59`],
    )
    const rows = (await query(
      `SELECT id, payment_no, amount, method, COALESCE(paid_at, created_at) AS paid_on
         FROM \`billing_payments\` ${where}
        ORDER BY id DESC
        LIMIT 2000`,
      params,
    )) as any[]
    for (const r of rows) {
      records.push({
        id: `billing:${r.payment_no ?? r.id}`,
        amount: Number(r.amount ?? 0),
        label: `Billing payment ${r.payment_no ?? r.id}`,
        occurredAt: r.paid_on ? new Date(r.paid_on).toISOString() : null,
        party: r.method ? String(r.method) : null,
      })
      dates.push({ date: r.paid_on ?? null, value: 1 })
    }
  } catch (err) {
    console.error("[v0] anomaly collectPayments (billing) failed:", err)
  }

  return { records, series: bucketDaily(from, to, dates, "count") }
}

// ---------------------------------------------------------------------------
// Invoices — global ERP sales_invoices ledger.
// ---------------------------------------------------------------------------

async function collectInvoices(
  fromDate: string,
  toDate: string,
  from: Date,
  to: Date,
  includeErpLedger: boolean,
): Promise<{ records: AmountObservation[]; series: SeriesPoint[] }> {
  const erp = includeErpLedger ? await collectErpInvoices(fromDate, toDate) : { records: [], dates: [] }
  const billing = await collectBillingInvoices(fromDate, toDate)
  return {
    records: [...erp.records, ...billing.records],
    series: bucketDaily(from, to, [...erp.dates, ...billing.dates], "count"),
  }
}

type MonetaryRows = { records: AmountObservation[]; dates: { date: string | null; value: number }[] }

async function collectBillingInvoices(fromDate: string, toDate: string): Promise<MonetaryRows> {
  try {
    const { where, params } = scopedWhere(
      "billing_invoices",
      "issue_date >= ? AND issue_date <= ? AND status NOT IN ('draft', 'void')",
      [fromDate, toDate],
    )
    const rows = (await query(
      `SELECT id, invoice_no, issue_date, total, customer_name
         FROM \`billing_invoices\` ${where}
        ORDER BY issue_date DESC, id DESC
        LIMIT 2000`,
      params,
    )) as any[]
    return {
      records: rows.map((r) => ({
        id: `billing:${r.invoice_no ?? r.id}`,
        amount: Number(r.total ?? 0),
        label: `Billing invoice ${r.invoice_no ?? r.id}`,
        occurredAt: r.issue_date ? new Date(r.issue_date).toISOString() : null,
        party: r.customer_name || null,
      })),
      dates: rows.map((r) => ({ date: r.issue_date ?? null, value: 1 })),
    }
  } catch (err) {
    console.error("[v0] anomaly collectInvoices (billing) failed:", err)
    return { records: [], dates: [] }
  }
}

async function collectErpInvoices(fromDate: string, toDate: string): Promise<MonetaryRows> {
  try {
    const rows = (await query(
      `SELECT invoice_id, invoice_date, net_receivable, invoice_status, invoice_type, party_name
         FROM sales_invoices
        WHERE invoice_date >= ? AND invoice_date <= ?
          AND (invoice_type IS NULL OR invoice_type <> 'Proforma Invoice')
        ORDER BY invoice_date DESC, id DESC
        LIMIT 2000`,
      [fromDate, toDate],
    )) as any[]
    const records: AmountObservation[] = rows.map((r) => ({
      id: String(r.invoice_id),
      amount: Number(r.net_receivable ?? 0),
      label: r.invoice_id ? `Invoice ${r.invoice_id}` : null,
      occurredAt: r.invoice_date ? new Date(r.invoice_date).toISOString() : null,
      party: r.party_name ?? null,
    }))
    return { records, dates: rows.map((r) => ({ date: r.invoice_date ?? null, value: 1 })) }
  } catch (err) {
    // sales_invoices may not exist on a fresh install — treat as no data.
    console.error("[v0] anomaly collectInvoices (ERP ledger) failed:", err)
    return { records: [], dates: [] }
  }
}

/**
 * True only for the platform-owner tenant, which is the sole owner of the
 * global (tenant_id-less) ERP finance ledger. Fails closed: any error, a null
 * tenant, or a missing flag means the ledger is NOT read.
 */
export async function ownsGlobalErpLedger(tenantId: number | null): Promise<boolean> {
  if (tenantId == null) return false
  try {
    const rows = (await query("SELECT is_platform_owner FROM `tenants` WHERE id = ? LIMIT 1", [tenantId])) as any[]
    return Number(rows[0]?.is_platform_owner ?? 0) === 1
  } catch (err) {
    console.error("[v0] anomaly ownsGlobalErpLedger check failed:", err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Access — reuse the security-audit subsystem (tenant-aware reader).
// ---------------------------------------------------------------------------

const ACCESS_CATEGORIES = ["access_policy", "temporary_access", "emergency_bypass", "break_glass"] as const

/** Outcomes that represent a privilege being granted/elevated. */
const PRIVILEGE_OUTCOMES = new Set(["granted", "approved", "bypassed", "activated"])

async function collectAccess(
  from: Date,
  to: Date,
): Promise<{ series: SeriesPoint[]; events: AccessEvent[] }> {
  const tenantId = currentTenantForRead()
  try {
    const all: SecurityAuditEvent[] = []
    for (const category of ACCESS_CATEGORIES) {
      const rows = await listSecurityEvents(tenantId, { category, limit: 200 })
      all.push(...rows)
    }
    const inWindow = all.filter((e) => {
      const t = new Date(e.createdAt).getTime()
      return !Number.isNaN(t) && t >= from.getTime() && t <= to.getTime()
    })
    const events: AccessEvent[] = inWindow.map((e) => ({
      id: String(e.id),
      actorId: e.actorUserId,
      actorLabel: e.actorName ?? e.subjectEmail ?? null,
      action: e.action,
      outcome: e.outcome,
      occurredAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
      detail: e.detail,
    }))
    const series = bucketDaily(
      from,
      to,
      inWindow.map((e) => ({ date: e.createdAt ?? null, value: 1 })),
      "count",
    )
    return { series, events }
  } catch (err) {
    console.error("[v0] anomaly collectAccess failed:", err)
    return { series: [], events: [] }
  }
}

/** Access events that represent a privilege grant/elevation, for the direct rule. */
export function privilegeEvents(events: AccessEvent[]): AccessEvent[] {
  return events.filter(
    (e) => PRIVILEGE_OUTCOMES.has(String(e.outcome).toLowerCase()) || /privileg|role|admin|elevat|grant/i.test(e.action),
  )
}

// ---------------------------------------------------------------------------
// Usage — reuse usage-metering's usage_events (guard-registered tenant table).
// ---------------------------------------------------------------------------

async function collectUsage(
  fromDate: string,
  toDate: string,
  from: Date,
  to: Date,
): Promise<UsageMeterSeries[]> {
  try {
    const { where, params } = scopedWhere(
      "usage_events",
      "occurred_at >= ? AND occurred_at <= ?",
      [`${fromDate} 00:00:00`, `${toDate} 23:59:59`],
    )
    const rows = (await query(
      `SELECT meter_key, DATE(occurred_at) AS day, SUM(quantity) AS total
         FROM \`usage_events\` ${where}
        GROUP BY meter_key, DATE(occurred_at)
        ORDER BY meter_key ASC, day ASC`,
      params,
    )) as any[]
    const byMeter = new Map<string, { date: string | null; value: number }[]>()
    for (const r of rows) {
      const key = String(r.meter_key)
      const arr = byMeter.get(key) ?? []
      arr.push({ date: r.day ? new Date(r.day).toISOString() : null, value: Number(r.total ?? 0) })
      byMeter.set(key, arr)
    }
    return [...byMeter.entries()].map(([meterKey, rows]) => ({
      meterKey,
      series: bucketDaily(from, to, rows, "sum"),
    }))
  } catch (err) {
    console.error("[v0] anomaly collectUsage failed:", err)
    return []
  }
}

/** The tenant id for the security-audit reader; null in a system context. */
function currentTenantForRead(): number | null {
  return currentTenantIdOrNull()
}
