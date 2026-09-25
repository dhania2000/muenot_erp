/**
 * Spec31 (#174-175) — Customer success & product analytics: pure logic.
 * ---------------------------------------------------------------------------
 * No DB / server-only imports so every rule here is unit-tested directly:
 *  - usage-event validation (a strict allowlist — anything that is not a module
 *    key, feature key or action verb is DROPPED, so free text / personal content
 *    can never reach storage)
 *  - pseudonymous actor hashing and the event deduplication key
 *  - retention and opt-out settings validation
 *  - the explainable tenant health score, churn-risk factors and trend
 */
import { createHash, createHmac } from "node:crypto"

export class CustomerSuccessError extends Error {
  code: string
  status: number
  constructor(message: string, code = "CS_ERROR", status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------
export const EVENT_ACTIONS = ["view", "open", "create", "update", "delete", "export", "import", "run", "search"] as const
export type EventAction = (typeof EVENT_ACTIONS)[number]
export const MAX_EVENTS_PER_BATCH = 50
/** Client clocks may lag; older events are rejected rather than back-filled. */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000
export const MAX_EVENT_SKEW_MS = 5 * 60 * 1000

const MODULE_RE = /^[a-z][a-z0-9_]{1,39}$/
const FEATURE_RE = /^[a-z][a-z0-9_.-]{1,63}$/
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{8,100}$/

export type NormalizedEvent = {
  module: string
  feature: string
  action: EventAction
  clientEventId: string | null
  occurredAt: Date
}

/**
 * Validate one event. Only the five allowlisted fields are read; every other
 * property (e.g. `email`, `note`, `payload`) is ignored and never persisted.
 */
export function normalizeEvent(raw: unknown, now: Date): NormalizedEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CustomerSuccessError("Each event must be an object", "INVALID_EVENT")
  }
  const r = raw as Record<string, unknown>
  const module = typeof r.module === "string" ? r.module.trim().toLowerCase() : ""
  const feature = typeof r.feature === "string" ? r.feature.trim().toLowerCase() : ""
  const action = typeof r.action === "string" ? r.action.trim().toLowerCase() : "view"
  if (!MODULE_RE.test(module)) throw new CustomerSuccessError("module must be a lowercase key (2-40 chars)", "INVALID_MODULE")
  if (!FEATURE_RE.test(feature)) throw new CustomerSuccessError("feature must be a lowercase key (2-64 chars)", "INVALID_FEATURE")
  if (!(EVENT_ACTIONS as readonly string[]).includes(action)) {
    throw new CustomerSuccessError(`action must be one of ${EVENT_ACTIONS.join(", ")}`, "INVALID_ACTION")
  }
  let clientEventId: string | null = null
  if (r.clientEventId != null) {
    if (typeof r.clientEventId !== "string" || !CLIENT_ID_RE.test(r.clientEventId)) {
      throw new CustomerSuccessError("clientEventId must be 8-100 URL-safe characters", "INVALID_CLIENT_EVENT_ID")
    }
    clientEventId = r.clientEventId
  }
  let occurredAt = now
  if (r.occurredAt != null) {
    const d = typeof r.occurredAt === "string" ? new Date(r.occurredAt) : null
    if (!d || Number.isNaN(d.getTime())) throw new CustomerSuccessError("occurredAt must be an ISO timestamp", "INVALID_OCCURRED_AT")
    const delta = now.getTime() - d.getTime()
    if (delta > MAX_EVENT_AGE_MS || delta < -MAX_EVENT_SKEW_MS) {
      throw new CustomerSuccessError("occurredAt must be within the last 24 hours", "INVALID_OCCURRED_AT")
    }
    occurredAt = d
  }
  return { module, feature, action: action as EventAction, clientEventId, occurredAt }
}

export function normalizeEventBatch(body: unknown, now: Date): NormalizedEvent[] {
  const events = (body as { events?: unknown } | null)?.events
  if (!Array.isArray(events) || events.length === 0) {
    throw new CustomerSuccessError("events must be a non-empty array", "INVALID_BATCH")
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    throw new CustomerSuccessError(`At most ${MAX_EVENTS_PER_BATCH} events per request`, "BATCH_TOO_LARGE")
  }
  return events.map((e) => normalizeEvent(e, now))
}

/**
 * Pseudonymous, tenant-salted actor id. Keyed HMAC so the raw user id cannot be
 * recovered or joined across tenants from the analytics tables.
 */
export function actorHash(secret: string, tenantId: number, userId: number): string {
  if (!secret) throw new CustomerSuccessError("Analytics hashing secret is not configured", "NOT_CONFIGURED", 503)
  return createHmac("sha256", secret).update(`${tenantId}:${userId}`).digest("hex").slice(0, 32)
}

/**
 * Deduplication key, unique per tenant:
 *  - with a clientEventId: retries of the same client event collapse
 *  - without one: identical (actor, module, feature, action) inside the same
 *    UTC minute collapse (double clicks, re-renders, network retries)
 */
export function dedupKey(tenantId: number, actor: string, e: NormalizedEvent): string {
  const basis = e.clientEventId
    ? `c|${tenantId}|${actor}|${e.clientEventId}`
    : `w|${tenantId}|${actor}|${e.module}|${e.feature}|${e.action}|${Math.floor(e.occurredAt.getTime() / 60000)}`
  return createHash("sha256").update(basis).digest("hex")
}

// ---------------------------------------------------------------------------
// Settings: retention + opt-out
// ---------------------------------------------------------------------------
export const RETENTION_MIN_DAYS = 30
export const RETENTION_MAX_DAYS = 730
export const RETENTION_DEFAULT_DAYS = 180
/** Aggregated daily counts contain no actor data and are kept this long. */
export const ROLLUP_RETENTION_DAYS = 730

export type CsSettings = { analyticsOptOut: boolean; retentionDays: number }
export const DEFAULT_SETTINGS: CsSettings = { analyticsOptOut: false, retentionDays: RETENTION_DEFAULT_DAYS }

export function validateSettingsPatch(body: unknown): Partial<CsSettings> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CustomerSuccessError("Body must be an object", "INVALID_SETTINGS")
  }
  const b = body as Record<string, unknown>
  const patch: Partial<CsSettings> = {}
  if (b.analyticsOptOut !== undefined) {
    if (typeof b.analyticsOptOut !== "boolean") throw new CustomerSuccessError("analyticsOptOut must be a boolean", "INVALID_SETTINGS")
    patch.analyticsOptOut = b.analyticsOptOut
  }
  if (b.retentionDays !== undefined) {
    const n = b.retentionDays
    if (typeof n !== "number" || !Number.isInteger(n) || n < RETENTION_MIN_DAYS || n > RETENTION_MAX_DAYS) {
      throw new CustomerSuccessError(`retentionDays must be an integer ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS}`, "INVALID_SETTINGS")
    }
    patch.retentionDays = n
  }
  if (Object.keys(patch).length === 0) throw new CustomerSuccessError("No supported settings supplied", "INVALID_SETTINGS")
  return patch
}

export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 86_400_000)
}

// ---------------------------------------------------------------------------
// Health score
// ---------------------------------------------------------------------------
export type BillingStatus = "trialing" | "active" | "past_due" | "canceled" | "none"

/** Counts only — never names, messages, ticket text or user identifiers. */
export type HealthSignals = {
  adoption: {
    available: boolean
    activeUsers30d: number
    seats: number
    modulesUsed30d: number
    events30d: number
    eventsPrev30d: number
  }
  errors: { errors7d: number; critical7d: number }
  jobs: { total7d: number; failed7d: number }
  billing: { status: BillingStatus; overdueInvoices: number }
  support: { open: number; urgentOpen: number; breached30d: number }
}

export type FactorKey = "adoption" | "errors" | "jobs" | "billing" | "support"
export const FACTOR_WEIGHTS: Record<FactorKey, number> = { adoption: 30, errors: 20, jobs: 15, billing: 20, support: 15 }
export const FACTOR_LABELS: Record<FactorKey, string> = {
  adoption: "Product adoption",
  errors: "Application errors",
  jobs: "Background jobs",
  billing: "Billing standing",
  support: "Support load",
}

export type HealthFactor = {
  key: FactorKey
  label: string
  weight: number
  /** Weight after excluding unavailable factors; effective weights sum to 100. */
  effectiveWeight: number
  available: boolean
  score: number
  /** Points this factor adds to the overall score; contributions sum to the score. */
  contribution: number
  reasons: string[]
}

export type HealthBand = "healthy" | "watch" | "at_risk"
export type RiskSeverity = "high" | "medium"
export type ChurnRisk = { key: string; factor: FactorKey; severity: RiskSeverity; message: string }
export type HealthResult = { score: number; band: HealthBand; factors: HealthFactor[]; risks: ChurnRisk[] }

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const round1 = (n: number) => Math.round(n * 10) / 10

function scoreAdoption(a: HealthSignals["adoption"]): { score: number; reasons: string[] } {
  const ratio = a.seats > 0 ? Math.min(1, a.activeUsers30d / a.seats) : a.activeUsers30d > 0 ? 1 : 0
  const breadth = Math.min(1, a.modulesUsed30d / 5)
  return {
    score: clamp(100 * (0.6 * ratio + 0.4 * breadth)),
    reasons: [
      `${a.activeUsers30d} of ${a.seats} active seats used the product in 30 days (${Math.round(ratio * 100)}%)`,
      `${a.modulesUsed30d} module(s) used in 30 days (5+ scores full breadth)`,
    ],
  }
}

function scoreErrors(e: HealthSignals["errors"]) {
  return {
    score: clamp(100 - e.errors7d * 2 - e.critical7d * 10),
    reasons: [`${e.errors7d} error and ${e.critical7d} critical log event(s) in 7 days (-2 / -10 each)`],
  }
}

function scoreJobs(j: HealthSignals["jobs"]) {
  if (j.total7d === 0) return { score: 100, reasons: ["No background jobs in 7 days (no failures observed)"] }
  const rate = j.failed7d / j.total7d
  return { score: clamp(100 * (1 - rate)), reasons: [`${j.failed7d} of ${j.total7d} background job(s) failed in 7 days (${Math.round(rate * 100)}%)`] }
}

const BILLING_BASE: Record<BillingStatus, number> = { active: 100, trialing: 80, none: 60, past_due: 30, canceled: 0 }
function scoreBilling(b: HealthSignals["billing"]) {
  return {
    score: clamp(BILLING_BASE[b.status] - b.overdueInvoices * 20),
    reasons: [`Subscription status: ${b.status} (base ${BILLING_BASE[b.status]})`, `${b.overdueInvoices} invoice(s) open for more than 30 days (-20 each)`],
  }
}

function scoreSupport(s: HealthSignals["support"]) {
  return {
    score: clamp(100 - s.open * 5 - s.urgentOpen * 10 - s.breached30d * 15),
    reasons: [`${s.open} open ticket(s) (-5 each), ${s.urgentOpen} high/urgent (-10 each)`, `${s.breached30d} SLA breach(es) in 30 days (-15 each)`],
  }
}

export function computeHealth(signals: HealthSignals): HealthResult {
  const raw: Array<{ key: FactorKey; available: boolean; score: number; reasons: string[] }> = [
    signals.adoption.available
      ? { key: "adoption", available: true, ...scoreAdoption(signals.adoption) }
      : { key: "adoption", available: false, score: 0, reasons: ["Usage analytics are disabled for this tenant; factor excluded and weights rebalanced"] },
    { key: "errors", available: true, ...scoreErrors(signals.errors) },
    { key: "jobs", available: true, ...scoreJobs(signals.jobs) },
    { key: "billing", available: true, ...scoreBilling(signals.billing) },
    { key: "support", available: true, ...scoreSupport(signals.support) },
  ]
  const totalWeight = raw.reduce((sum, f) => sum + (f.available ? FACTOR_WEIGHTS[f.key] : 0), 0)
  const exact = raw.map((f) => {
    const effectiveWeight = f.available ? (FACTOR_WEIGHTS[f.key] * 100) / totalWeight : 0
    return { ...f, effectiveWeight, contribution: (f.score * effectiveWeight) / 100 }
  })
  const score = clamp(exact.reduce((s, f) => s + f.contribution, 0))
  const factors: HealthFactor[] = exact.map((f) => ({
    key: f.key,
    label: FACTOR_LABELS[f.key],
    weight: FACTOR_WEIGHTS[f.key],
    effectiveWeight: round1(f.effectiveWeight),
    available: f.available,
    score: f.score,
    contribution: round1(f.contribution),
    reasons: f.reasons,
  }))
  return { score, band: bandFor(score), factors, risks: churnRisks(signals) }
}

export function bandFor(score: number): HealthBand {
  return score >= 75 ? "healthy" : score >= 50 ? "watch" : "at_risk"
}

/** Churn-risk factors — aggregated counts only, never personal content. */
export function churnRisks(s: HealthSignals): ChurnRisk[] {
  const risks: ChurnRisk[] = []
  const a = s.adoption
  if (a.available) {
    if (a.eventsPrev30d >= 20 && a.events30d < a.eventsPrev30d * 0.5) {
      const drop = Math.round((1 - a.events30d / a.eventsPrev30d) * 100)
      risks.push({ key: "usage_decline", factor: "adoption", severity: drop >= 75 ? "high" : "medium", message: `Product usage fell ${drop}% versus the previous 30 days` })
    }
    if (a.seats >= 3 && a.activeUsers30d / a.seats < 0.25) {
      risks.push({ key: "low_seat_activation", factor: "adoption", severity: "medium", message: `Only ${a.activeUsers30d} of ${a.seats} seats active in 30 days` })
    }
  }
  if (s.errors.critical7d > 0) risks.push({ key: "critical_errors", factor: "errors", severity: "high", message: `${s.errors.critical7d} critical error(s) in 7 days` })
  if (s.jobs.total7d >= 5 && s.jobs.failed7d / s.jobs.total7d > 0.2) {
    risks.push({ key: "job_failures", factor: "jobs", severity: "medium", message: `${Math.round((s.jobs.failed7d / s.jobs.total7d) * 100)}% of background jobs failed in 7 days` })
  }
  if (s.billing.status === "past_due" || s.billing.status === "canceled") {
    risks.push({ key: `billing_${s.billing.status}`, factor: "billing", severity: "high", message: `Subscription is ${s.billing.status.replace("_", " ")}` })
  }
  if (s.billing.overdueInvoices > 0) risks.push({ key: "overdue_invoices", factor: "billing", severity: "medium", message: `${s.billing.overdueInvoices} invoice(s) overdue by 30+ days` })
  if (s.support.breached30d > 0) risks.push({ key: "sla_breaches", factor: "support", severity: s.support.breached30d >= 3 ? "high" : "medium", message: `${s.support.breached30d} support SLA breach(es) in 30 days` })
  return risks
}

export type TrendPoint = { date: string; score: number }
export type Trend = { direction: "up" | "down" | "flat"; delta: number; points: TrendPoint[] }

export function computeTrend(points: TrendPoint[]): Trend {
  const sorted = [...points].sort((x, y) => x.date.localeCompare(y.date))
  if (sorted.length < 2) return { direction: "flat", delta: 0, points: sorted }
  const delta = sorted[sorted.length - 1].score - sorted[0].score
  return { direction: Math.abs(delta) < 3 ? "flat" : delta > 0 ? "up" : "down", delta, points: sorted }
}

// ---------------------------------------------------------------------------
// Platform list filters
// ---------------------------------------------------------------------------
export const HEALTH_BANDS: readonly HealthBand[] = ["healthy", "watch", "at_risk"]
export type TenantHealthFilter = { band?: HealthBand; q?: string; plan?: string; atRiskOnly?: boolean; page: number; pageSize: number }

export function parseTenantHealthFilter(params: URLSearchParams): TenantHealthFilter {
  const band = params.get("band")
  if (band && !(HEALTH_BANDS as readonly string[]).includes(band)) throw new CustomerSuccessError("Invalid band", "INVALID_FILTER")
  const q = (params.get("q") ?? "").trim()
  if (q.length > 100) throw new CustomerSuccessError("Search is too long", "INVALID_FILTER")
  const plan = (params.get("plan") ?? "").trim()
  if (plan && !/^[A-Za-z0-9_-]{1,50}$/.test(plan)) throw new CustomerSuccessError("Invalid plan", "INVALID_FILTER")
  const page = Number(params.get("page") ?? 1)
  const pageSize = Number(params.get("pageSize") ?? 25)
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new CustomerSuccessError("Invalid page", "INVALID_FILTER")
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new CustomerSuccessError("Invalid pageSize", "INVALID_FILTER")
  return {
    band: (band as HealthBand) || undefined,
    q: q || undefined,
    plan: plan || undefined,
    atRiskOnly: params.get("risk") === "1" || params.get("risk") === "true",
    page,
    pageSize,
  }
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function toSqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}
export function toSqlDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
