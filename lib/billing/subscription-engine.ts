import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  tenantSelect,
  tenantInsert,
  tenantUpdate,
  requireOwnedRow,
} from "@/lib/tenant-scope"
import type { SessionPayload } from "@/lib/auth"
import {
  BILLING_TERMS,
  DEFAULT_LIFECYCLE,
  STATUS_LABELS,
  TERM_LABELS,
  addTerm,
  hasProductAccess,
  isBillingTerm,
  isTerminal,
  normalizeLifecycleConfig,
  reconcileLifecycle,
  termMonths,
  toISODate,
  type BillingTerm,
  type LifecycleConfig,
  type SubscriptionStatus,
} from "@/lib/billing/subscription-lifecycle"

/**
 * SPEC 16 — SaaS subscription engine (data + service layer).
 * ---------------------------------------------------------------------------
 * Muenot both runs the ERP internally and sells it as SaaS. This module owns
 * every customer tenant's subscription to the product: the plan catalogue
 * (global), each tenant's subscription record (tenant-scoped), and an
 * append-only event log (tenant-scoped) for auditability.
 *
 * All tenant-scoped reads/writes go through lib/tenant-scope helpers so they
 * always carry a tenant_id predicate and satisfy the fail-closed guard
 * (SPEC 2). Plans are a global catalogue and use the raw query() layer.
 *
 * The lifecycle math is pure and tested (lib/billing/subscription-lifecycle.ts +
 * test/subscription-engine.test.ts); this file composes it with persistence,
 * validation, authorization (via the callers) and audit logging.
 */

export class SubscriptionError extends Error {
  status: number
  fields?: Record<string, string>
  constructor(message: string, status = 400, fields?: Record<string, string>) {
    super(message)
    this.name = "SubscriptionError"
    this.status = status
    this.fields = fields
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export type Plan = {
  id: number
  plan_code: string
  name: string
  description: string | null
  currency: string
  price_monthly: number
  price_yearly: number
  price_two_year: number
  price_five_year: number
  trial_days: number
  seats: number | null
  past_due_days: number
  grace_days: number
  suspend_days: number
  is_active: boolean
  is_public: boolean
  created_at: string
  updated_at: string
}

export type Subscription = {
  id: number
  subscription_no: string
  tenant_id: number
  plan_id: number | null
  plan_code: string | null
  plan_name: string
  term: BillingTerm
  currency: string
  amount: number
  seats: number | null
  status: SubscriptionStatus
  auto_renew: boolean
  cancel_at_period_end: boolean
  trial_end_date: string | null
  start_date: string
  current_period_start: string
  current_period_end: string
  past_due_days: number
  grace_days: number
  suspend_days: number
  renewal_count: number
  last_payment_at: string | null
  canceled_at: string | null
  cancel_reason: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

/** A subscription enriched with derived, non-persisted presentation fields. */
export type SubscriptionView = Subscription & {
  status_label: string
  term_label: string
  term_months: number
  days_to_renewal: number | null
  has_access: boolean
  monthly_amount: number
}

// ── Schema (self-healing, matches the project's ensure pattern) ───────────────

let schemaEnsured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  // Global plan catalogue — shared across every tenant (NOT tenant-scoped).
  await query(`CREATE TABLE IF NOT EXISTS saas_plans (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    plan_code       VARCHAR(30) NOT NULL,
    name            VARCHAR(150) NOT NULL,
    description     TEXT DEFAULT NULL,
    currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
    price_monthly   DECIMAL(14,2) NOT NULL DEFAULT 0,
    price_yearly    DECIMAL(14,2) NOT NULL DEFAULT 0,
    price_two_year  DECIMAL(14,2) NOT NULL DEFAULT 0,
    price_five_year DECIMAL(14,2) NOT NULL DEFAULT 0,
    trial_days      INT UNSIGNED NOT NULL DEFAULT 0,
    seats           INT UNSIGNED DEFAULT NULL,
    past_due_days   INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_LIFECYCLE.pastDueDays},
    grace_days      INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_LIFECYCLE.graceDays},
    suspend_days    INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_LIFECYCLE.suspendDays},
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    is_public       TINYINT(1) NOT NULL DEFAULT 1,
    created_by      INT UNSIGNED DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_saas_plan_code (plan_code),
    KEY idx_saas_plan_active (is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS saas_subscriptions (
    id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
    subscription_no      VARCHAR(30) NOT NULL,
    tenant_id            INT UNSIGNED NOT NULL,
    plan_id              INT UNSIGNED DEFAULT NULL,
    plan_code            VARCHAR(30) DEFAULT NULL,
    plan_name            VARCHAR(150) NOT NULL,
    term                 VARCHAR(20) NOT NULL DEFAULT 'monthly',
    currency             VARCHAR(10) NOT NULL DEFAULT 'USD',
    amount               DECIMAL(14,2) NOT NULL DEFAULT 0,
    seats                INT UNSIGNED DEFAULT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'active',
    auto_renew           TINYINT(1) NOT NULL DEFAULT 1,
    cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
    trial_end_date       DATE DEFAULT NULL,
    start_date           DATE NOT NULL,
    current_period_start DATE NOT NULL,
    current_period_end   DATE NOT NULL,
    past_due_days        INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_LIFECYCLE.pastDueDays},
    grace_days           INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_LIFECYCLE.graceDays},
    suspend_days         INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_LIFECYCLE.suspendDays},
    renewal_count        INT UNSIGNED NOT NULL DEFAULT 0,
    last_payment_at      DATETIME DEFAULT NULL,
    canceled_at          DATETIME DEFAULT NULL,
    cancel_reason        VARCHAR(255) DEFAULT NULL,
    ended_at             DATETIME DEFAULT NULL,
    created_by           INT UNSIGNED DEFAULT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_saas_subscription_no (subscription_no),
    KEY idx_saas_subscriptions_tenant (tenant_id),
    KEY idx_saas_sub_status (status),
    KEY idx_saas_sub_period_end (current_period_end)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS saas_subscription_events (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id       INT UNSIGNED NOT NULL,
    subscription_id INT UNSIGNED NOT NULL,
    subscription_no VARCHAR(30) DEFAULT NULL,
    event_type      VARCHAR(30) NOT NULL,
    from_status     VARCHAR(20) DEFAULT NULL,
    to_status       VARCHAR(20) DEFAULT NULL,
    amount          DECIMAL(14,2) DEFAULT NULL,
    currency        VARCHAR(10) DEFAULT NULL,
    period_start    DATE DEFAULT NULL,
    period_end      DATE DEFAULT NULL,
    note            VARCHAR(255) DEFAULT NULL,
    actor_id        INT UNSIGNED DEFAULT NULL,
    actor_name      VARCHAR(190) DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_saas_subscription_events_tenant (tenant_id),
    KEY idx_saas_evt_sub (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await seedDefaultPlans()
}

/** Ensure the subscription schema exists. Cached per process. */
export async function ensureSubscriptionSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = runEnsure().catch((err) => {
      schemaEnsured = null
      throw err
    })
  }
  return schemaEnsured
}

/** Seed a small, sensible plan catalogue once (idempotent on plan_code). */
async function seedDefaultPlans(): Promise<void> {
  const existing = (await query(`SELECT COUNT(*) AS n FROM saas_plans`)) as { n: number }[]
  if (Number(existing[0]?.n ?? 0) > 0) return
  const defaults: Array<Omit<Plan, "id" | "created_at" | "updated_at">> = [
    {
      plan_code: "PLAN-STARTER",
      name: "Starter",
      description: "For small teams getting started with Muenot ERP.",
      currency: "USD",
      price_monthly: 29,
      price_yearly: 290,
      price_two_year: 522,
      price_five_year: 1044,
      trial_days: 14,
      seats: 10,
      past_due_days: 7,
      grace_days: 14,
      suspend_days: 30,
      is_active: true,
      is_public: true,
    },
    {
      plan_code: "PLAN-GROWTH",
      name: "Growth",
      description: "For scaling SMEs that need the full operations suite.",
      currency: "USD",
      price_monthly: 99,
      price_yearly: 990,
      price_two_year: 1782,
      price_five_year: 3564,
      trial_days: 14,
      seats: 50,
      past_due_days: 7,
      grace_days: 14,
      suspend_days: 30,
      is_active: true,
      is_public: true,
    },
    {
      plan_code: "PLAN-ENTERPRISE",
      name: "Enterprise",
      description: "For enterprises and MNCs with unlimited seats and priority support.",
      currency: "USD",
      price_monthly: 499,
      price_yearly: 4990,
      price_two_year: 8982,
      price_five_year: 17964,
      trial_days: 30,
      seats: null,
      past_due_days: 14,
      grace_days: 30,
      suspend_days: 60,
      is_active: true,
      is_public: true,
    },
  ]
  for (const p of defaults) {
    await query(
      `INSERT INTO saas_plans
         (plan_code, name, description, currency, price_monthly, price_yearly, price_two_year, price_five_year,
          trial_days, seats, past_due_days, grace_days, suspend_days, is_active, is_public)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE plan_code = plan_code`,
      [
        p.plan_code, p.name, p.description, p.currency,
        p.price_monthly, p.price_yearly, p.price_two_year, p.price_five_year,
        p.trial_days, p.seats, p.past_due_days, p.grace_days, p.suspend_days,
        p.is_active ? 1 : 0, p.is_public ? 1 : 0,
      ],
    ).catch((e) => console.log("[v0] saas plan seed failed", (e as Error).message))
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const today = () => toISODate(new Date())
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const bool = (v: any) => v === true || v === 1 || v === "1" || v === "true"
const dateOf = (v: any) => (v ? String(v).slice(0, 10) : null)

function mapPlan(r: any): Plan {
  return {
    id: Number(r.id),
    plan_code: String(r.plan_code),
    name: String(r.name),
    description: r.description ?? null,
    currency: String(r.currency),
    price_monthly: num(r.price_monthly),
    price_yearly: num(r.price_yearly),
    price_two_year: num(r.price_two_year),
    price_five_year: num(r.price_five_year),
    trial_days: num(r.trial_days),
    seats: r.seats == null ? null : num(r.seats),
    past_due_days: num(r.past_due_days),
    grace_days: num(r.grace_days),
    suspend_days: num(r.suspend_days),
    is_active: bool(r.is_active),
    is_public: bool(r.is_public),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }
}

function planPriceForTerm(plan: Plan, term: BillingTerm): number {
  switch (term) {
    case "monthly":
      return plan.price_monthly
    case "yearly":
      return plan.price_yearly
    case "two_year":
      return plan.price_two_year
    case "five_year":
      return plan.price_five_year
  }
}

function mapSubscription(r: any): Subscription {
  return {
    id: Number(r.id),
    subscription_no: String(r.subscription_no),
    tenant_id: Number(r.tenant_id),
    plan_id: r.plan_id == null ? null : Number(r.plan_id),
    plan_code: r.plan_code ?? null,
    plan_name: String(r.plan_name),
    term: (isBillingTerm(r.term) ? r.term : "monthly") as BillingTerm,
    currency: String(r.currency),
    amount: num(r.amount),
    seats: r.seats == null ? null : num(r.seats),
    status: String(r.status) as SubscriptionStatus,
    auto_renew: bool(r.auto_renew),
    cancel_at_period_end: bool(r.cancel_at_period_end),
    trial_end_date: dateOf(r.trial_end_date),
    start_date: dateOf(r.start_date)!,
    current_period_start: dateOf(r.current_period_start)!,
    current_period_end: dateOf(r.current_period_end)!,
    past_due_days: num(r.past_due_days),
    grace_days: num(r.grace_days),
    suspend_days: num(r.suspend_days),
    renewal_count: num(r.renewal_count),
    last_payment_at: r.last_payment_at ? String(r.last_payment_at) : null,
    canceled_at: r.canceled_at ? String(r.canceled_at) : null,
    cancel_reason: r.cancel_reason ?? null,
    ended_at: r.ended_at ? String(r.ended_at) : null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }
}

function lifecycleConfigOf(s: Subscription): LifecycleConfig {
  return normalizeLifecycleConfig({
    pastDueDays: s.past_due_days,
    graceDays: s.grace_days,
    suspendDays: s.suspend_days,
  })
}

function toView(s: Subscription, now = today()): SubscriptionView {
  const daysToRenewal = hasProductAccess(s.status)
    ? Math.round((new Date(`${s.current_period_end}T00:00:00Z`).getTime() - new Date(`${now}T00:00:00Z`).getTime()) / 86_400_000)
    : null
  return {
    ...s,
    status_label: STATUS_LABELS[s.status] ?? s.status,
    term_label: TERM_LABELS[s.term] ?? s.term,
    term_months: termMonths(s.term),
    days_to_renewal: daysToRenewal,
    has_access: hasProductAccess(s.status),
    monthly_amount: s.amount / termMonths(s.term),
  }
}

// ── Event log ─────────────────────────────────────────────────────────────────

type EventInput = {
  subscriptionId: number
  subscriptionNo?: string | null
  eventType: string
  fromStatus?: string | null
  toStatus?: string | null
  amount?: number | null
  currency?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  note?: string | null
  actorId?: number | null
  actorName?: string | null
}

async function logEvent(input: EventInput): Promise<void> {
  await tenantInsert("saas_subscription_events", {
    subscription_id: input.subscriptionId,
    subscription_no: input.subscriptionNo ?? null,
    event_type: input.eventType,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    period_start: input.periodStart ?? null,
    period_end: input.periodEnd ?? null,
    note: input.note ?? null,
    actor_id: input.actorId ?? null,
    actor_name: input.actorName ?? null,
  }).catch((e) => console.log("[v0] saas subscription event insert failed", (e as Error).message))
}

// ── Plans ─────────────────────────────────────────────────────────────────────

export async function listPlans(opts: { activeOnly?: boolean } = {}): Promise<Plan[]> {
  await ensureSubscriptionSchema()
  const where = opts.activeOnly ? "WHERE is_active = 1" : ""
  const rows = (await query(
    `SELECT * FROM saas_plans ${where} ORDER BY price_monthly ASC`,
  )) as any[]
  return rows.map(mapPlan)
}

export async function getPlan(id: number): Promise<Plan | null> {
  await ensureSubscriptionSchema()
  const rows = (await query(`SELECT * FROM saas_plans WHERE id = ? LIMIT 1`, [id])) as any[]
  return rows[0] ? mapPlan(rows[0]) : null
}

export type PlanInput = {
  name?: string
  description?: string | null
  currency?: string
  price_monthly?: number | string
  price_yearly?: number | string
  price_two_year?: number | string
  price_five_year?: number | string
  trial_days?: number | string
  seats?: number | string | null
  past_due_days?: number | string
  grace_days?: number | string
  suspend_days?: number | string
  is_active?: boolean
  is_public?: boolean
}

function validatePlan(input: PlanInput, partial = false) {
  const fields: Record<string, string> = {}
  if (!partial || input.name !== undefined) {
    if (!String(input.name ?? "").trim()) fields.name = "Plan name is required."
  }
  for (const k of ["price_monthly", "price_yearly", "price_two_year", "price_five_year"] as const) {
    if (input[k] !== undefined && num(input[k]) < 0) fields[k] = "Price cannot be negative."
  }
  if (input.trial_days !== undefined && num(input.trial_days) < 0) fields.trial_days = "Trial days cannot be negative."
  if (input.seats !== undefined && input.seats !== null && Number(input.seats) < 0)
    fields.seats = "Seats cannot be negative."
  if (Object.keys(fields).length) throw new SubscriptionError("Validation failed", 400, fields)
}

export async function createPlan(input: PlanInput, session: SessionPayload): Promise<Plan> {
  await ensureSubscriptionSchema()
  validatePlan(input)
  const code = await nextRecordId("PLAN", { digits: 4, allowCustom: true })
  const seats = input.seats === null || input.seats === undefined || input.seats === ("" as any) ? null : num(input.seats)
  const cfg = normalizeLifecycleConfig({
    pastDueDays: input.past_due_days as any,
    graceDays: input.grace_days as any,
    suspendDays: input.suspend_days as any,
  })
  const res = (await query(
    `INSERT INTO saas_plans
       (plan_code, name, description, currency, price_monthly, price_yearly, price_two_year, price_five_year,
        trial_days, seats, past_due_days, grace_days, suspend_days, is_active, is_public, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code,
      String(input.name).trim(),
      input.description ?? null,
      String(input.currency || "USD").trim(),
      num(input.price_monthly),
      num(input.price_yearly),
      num(input.price_two_year),
      num(input.price_five_year),
      num(input.trial_days),
      seats,
      cfg.pastDueDays,
      cfg.graceDays,
      cfg.suspendDays,
      input.is_active === false ? 0 : 1,
      input.is_public === false ? 0 : 1,
      session.userId,
    ],
  )) as any
  const created = await getPlan(Number(res.insertId))
  if (!created) throw new SubscriptionError("Failed to load the plan just created", 500)
  return created
}

export async function updatePlan(id: number, input: PlanInput): Promise<Plan> {
  await ensureSubscriptionSchema()
  validatePlan(input, true)
  const existing = await getPlan(id)
  if (!existing) throw new SubscriptionError("Plan not found", 404)
  const set: Record<string, any> = {}
  const map: Record<string, (v: any) => any> = {
    name: (v) => String(v).trim(),
    description: (v) => v ?? null,
    currency: (v) => String(v || "USD").trim(),
    price_monthly: num,
    price_yearly: num,
    price_two_year: num,
    price_five_year: num,
    trial_days: num,
    seats: (v) => (v === null || v === "" ? null : num(v)),
    past_due_days: num,
    grace_days: num,
    suspend_days: num,
    is_active: (v) => (v ? 1 : 0),
    is_public: (v) => (v ? 1 : 0),
  }
  for (const [k, fn] of Object.entries(map)) {
    if ((input as any)[k] !== undefined) set[k] = fn((input as any)[k])
  }
  if (Object.keys(set).length === 0) return existing
  const cols = Object.keys(set)
  await query(
    `UPDATE saas_plans SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    [...cols.map((c) => set[c]), id],
  )
  const updated = await getPlan(id)
  return updated!
}

// ── Subscriptions: reads ──────────────────────────────────────────────────────

export async function listSubscriptions(): Promise<SubscriptionView[]> {
  await ensureSubscriptionSchema()
  const rows = (await tenantSelect("saas_subscriptions", {
    tail: "ORDER BY created_at DESC",
  })) as any[]
  const subs = rows.map(mapSubscription)
  // Refresh lifecycle on read so the list is always accurate even between cron
  // runs. Persist any transitions.
  const now = today()
  const out: SubscriptionView[] = []
  for (const s of subs) {
    const refreshed = await applyReconcile(s, now, null)
    out.push(toView(refreshed, now))
  }
  return out
}

export async function getSubscriptionView(id: number): Promise<SubscriptionView | null> {
  await ensureSubscriptionSchema()
  const row = (await requireOwnedRow("saas_subscriptions", id).catch(() => null)) as any
  if (!row) return null
  const refreshed = await applyReconcile(mapSubscription(row), today(), null)
  return toView(refreshed)
}

/** The tenant's current (non-terminal) subscription, if any. */
export async function getActiveSubscription(): Promise<SubscriptionView | null> {
  const all = await listSubscriptions()
  return all.find((s) => !isTerminal(s.status)) ?? null
}

export type SubscriptionSummary = {
  total: number
  by_status: Record<SubscriptionStatus, number>
  active_mrr: number
  currency: string
  renewals_due_30d: number
  at_risk: number
}

export async function getSummary(): Promise<SubscriptionSummary> {
  const subs = await listSubscriptions()
  const by_status = Object.fromEntries(
    (Object.keys(STATUS_LABELS) as SubscriptionStatus[]).map((k) => [k, 0]),
  ) as Record<SubscriptionStatus, number>
  let active_mrr = 0
  let renewals_due_30d = 0
  let at_risk = 0
  let currency = "USD"
  for (const s of subs) {
    by_status[s.status] = (by_status[s.status] ?? 0) + 1
    if (s.status === "active" || s.status === "trial") active_mrr += s.monthly_amount
    if (s.currency) currency = s.currency
    if (s.days_to_renewal != null && s.days_to_renewal >= 0 && s.days_to_renewal <= 30) renewals_due_30d++
    if (s.status === "past_due" || s.status === "grace" || s.status === "suspended") at_risk++
  }
  return {
    total: subs.length,
    by_status,
    active_mrr: Math.round(active_mrr * 100) / 100,
    currency,
    renewals_due_30d,
    at_risk,
  }
}

export async function listEvents(subscriptionId: number, limit = 100): Promise<any[]> {
  await ensureSubscriptionSchema()
  const rows = (await tenantSelect("saas_subscription_events", {
    where: "subscription_id = ?",
    params: [subscriptionId],
    tail: `ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(500, limit))}`,
  })) as any[]
  return rows
}

// ── Subscriptions: create ──────────────────────────────────────────────────────

export type SubscribeInput = {
  plan_id: number
  term: string
  auto_renew?: boolean
  with_trial?: boolean
  start_date?: string | null
  seats?: number | string | null
}

export async function subscribe(input: SubscribeInput, session: SessionPayload): Promise<SubscriptionView> {
  await ensureSubscriptionSchema()

  if (!isBillingTerm(input.term)) {
    throw new SubscriptionError("Invalid billing term", 400, {
      term: `Term must be one of: ${BILLING_TERMS.join(", ")}`,
    })
  }
  const plan = await getPlan(Number(input.plan_id))
  if (!plan) throw new SubscriptionError("Plan not found", 404, { plan_id: "Select a valid plan." })
  if (!plan.is_active) throw new SubscriptionError("This plan is not available.", 400, { plan_id: "Plan is inactive." })

  // Business rule: one live subscription per tenant.
  const existing = await getActiveSubscription()
  if (existing) {
    throw new SubscriptionError(
      "This tenant already has a live subscription. Change or cancel it before subscribing again.",
      409,
    )
  }

  const term = input.term as BillingTerm
  const startDate = dateOf(input.start_date) || today()
  const withTrial = bool(input.with_trial) && plan.trial_days > 0
  const trialEnd = withTrial ? addDaysLocal(startDate, plan.trial_days) : null
  const periodStart = trialEnd ?? startDate
  const periodEnd = addTerm(periodStart, term)
  const status: SubscriptionStatus = withTrial ? "trial" : "active"
  const amount = planPriceForTerm(plan, term)
  const seats =
    input.seats === null || input.seats === undefined || input.seats === ("" as any)
      ? plan.seats
      : num(input.seats)

  const subscriptionNo = await nextRecordId("SAAS", { digits: 6, allowCustom: true })

  const { insertId } = await tenantInsert("saas_subscriptions", {
    subscription_no: subscriptionNo,
    plan_id: plan.id,
    plan_code: plan.plan_code,
    plan_name: plan.name,
    term,
    currency: plan.currency,
    amount,
    seats,
    status,
    auto_renew: input.auto_renew === false ? 0 : 1,
    cancel_at_period_end: 0,
    trial_end_date: trialEnd,
    start_date: startDate,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    past_due_days: plan.past_due_days,
    grace_days: plan.grace_days,
    suspend_days: plan.suspend_days,
    renewal_count: 0,
    last_payment_at: withTrial ? null : new Date().toISOString().slice(0, 19).replace("T", " "),
    created_by: session.userId,
  })

  await logEvent({
    subscriptionId: insertId,
    subscriptionNo,
    eventType: "created",
    toStatus: status,
    amount,
    currency: plan.currency,
    periodStart,
    periodEnd,
    note: `Subscribed to ${plan.name} (${TERM_LABELS[term]})${withTrial ? ` with ${plan.trial_days}-day trial` : ""}`,
    actorId: session.userId,
    actorName: session.name,
  })

  const view = await getSubscriptionView(insertId)
  return view!
}

function addDaysLocal(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Subscriptions: reconcile (lifecycle refresh) ──────────────────────────────

/**
 * Bring one subscription up to date and persist any lifecycle transition. Used
 * on read and by the cron sweep. `session` is optional (cron has none).
 */
async function applyReconcile(
  s: Subscription,
  now: string,
  session: SessionPayload | null,
): Promise<Subscription> {
  if (isTerminal(s.status)) return s
  const result = reconcileLifecycle(
    {
      status: s.status,
      term: s.term,
      autoRenew: s.auto_renew,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      trialEndDate: s.trial_end_date,
      currentPeriodStart: s.current_period_start,
      currentPeriodEnd: s.current_period_end,
      config: lifecycleConfigOf(s),
    },
    now,
  )
  if (!result.changed) return s

  const set: Record<string, any> = {
    status: result.status,
    current_period_start: result.currentPeriodStart,
    current_period_end: result.currentPeriodEnd,
  }
  if (result.renewalsApplied > 0) {
    set.renewal_count = s.renewal_count + result.renewalsApplied
    set.last_payment_at = new Date().toISOString().slice(0, 19).replace("T", " ")
  }
  if (result.status === "cancelled") set.canceled_at = new Date().toISOString().slice(0, 19).replace("T", " ")
  if (result.status === "expired") set.ended_at = new Date().toISOString().slice(0, 19).replace("T", " ")

  await tenantUpdate("saas_subscriptions", set, "id = ?", [s.id])

  const eventType =
    result.renewalsApplied > 0
      ? "auto_renewed"
      : result.status === "cancelled"
        ? "canceled"
        : "reconciled"
  await logEvent({
    subscriptionId: s.id,
    subscriptionNo: s.subscription_no,
    eventType,
    fromStatus: s.status,
    toStatus: result.status,
    amount: result.renewalsApplied > 0 ? s.amount : null,
    currency: s.currency,
    periodStart: result.currentPeriodStart,
    periodEnd: result.currentPeriodEnd,
    note:
      result.renewalsApplied > 0
        ? `Auto-renewed ${result.renewalsApplied} period(s)`
        : `Lifecycle → ${STATUS_LABELS[result.status]}`,
    actorId: session?.userId ?? null,
    actorName: session?.name ?? "system",
  })

  return { ...s, ...set, current_period_start: result.currentPeriodStart, current_period_end: result.currentPeriodEnd, status: result.status }
}

// ── Subscriptions: actions ─────────────────────────────────────────────────────

async function loadOwned(id: number): Promise<Subscription> {
  await ensureSubscriptionSchema()
  const row = (await requireOwnedRow("saas_subscriptions", id)) as any
  return mapSubscription(row)
}

/** Manual renewal / payment recording — extends by one term and restores access. */
export async function renewSubscription(
  id: number,
  session: SessionPayload,
  opts: { note?: string | null } = {},
): Promise<SubscriptionView> {
  const s = await loadOwned(id)
  if (s.status === "cancelled")
    throw new SubscriptionError("A cancelled subscription cannot be renewed. Create a new one.", 409)

  // Recovering from a lapse renews from today; an in-good-standing renewal
  // extends from the current period end (no lost time).
  const now = today()
  const base = hasProductAccess(s.status) ? s.current_period_end : now
  const newPeriodStart = hasProductAccess(s.status) ? s.current_period_end : now
  const newPeriodEnd = addTerm(base, s.term)

  await tenantUpdate(
    "saas_subscriptions",
    {
      status: "active",
      current_period_start: newPeriodStart,
      current_period_end: newPeriodEnd,
      renewal_count: s.renewal_count + 1,
      last_payment_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      cancel_at_period_end: 0,
      ended_at: null,
      canceled_at: null,
    },
    "id = ?",
    [s.id],
  )
  await logEvent({
    subscriptionId: s.id,
    subscriptionNo: s.subscription_no,
    eventType: "renewed",
    fromStatus: s.status,
    toStatus: "active",
    amount: s.amount,
    currency: s.currency,
    periodStart: newPeriodStart,
    periodEnd: newPeriodEnd,
    note: opts.note ?? "Manual renewal / payment recorded",
    actorId: session.userId,
    actorName: session.name,
  })
  return (await getSubscriptionView(s.id))!
}

export async function cancelSubscription(
  id: number,
  session: SessionPayload,
  opts: { atPeriodEnd?: boolean; reason?: string | null } = {},
): Promise<SubscriptionView> {
  const s = await loadOwned(id)
  if (s.status === "cancelled") return (await getSubscriptionView(s.id))!

  if (opts.atPeriodEnd && hasProductAccess(s.status)) {
    await tenantUpdate(
      "saas_subscriptions",
      { cancel_at_period_end: 1, auto_renew: 0, cancel_reason: opts.reason ?? null },
      "id = ?",
      [s.id],
    )
    await logEvent({
      subscriptionId: s.id,
      subscriptionNo: s.subscription_no,
      eventType: "cancel_scheduled",
      fromStatus: s.status,
      toStatus: s.status,
      note: opts.reason ?? "Cancellation scheduled at period end",
      actorId: session.userId,
      actorName: session.name,
    })
  } else {
    await tenantUpdate(
      "saas_subscriptions",
      {
        status: "cancelled",
        auto_renew: 0,
        cancel_at_period_end: 0,
        cancel_reason: opts.reason ?? null,
        canceled_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        ended_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      },
      "id = ?",
      [s.id],
    )
    await logEvent({
      subscriptionId: s.id,
      subscriptionNo: s.subscription_no,
      eventType: "canceled",
      fromStatus: s.status,
      toStatus: "cancelled",
      note: opts.reason ?? "Cancelled immediately",
      actorId: session.userId,
      actorName: session.name,
    })
  }
  return (await getSubscriptionView(s.id))!
}

export async function suspendSubscription(
  id: number,
  session: SessionPayload,
  opts: { reason?: string | null } = {},
): Promise<SubscriptionView> {
  const s = await loadOwned(id)
  if (isTerminal(s.status)) throw new SubscriptionError("Cannot suspend a terminal subscription.", 409)
  await tenantUpdate("saas_subscriptions", { status: "suspended" }, "id = ?", [s.id])
  await logEvent({
    subscriptionId: s.id,
    subscriptionNo: s.subscription_no,
    eventType: "suspended",
    fromStatus: s.status,
    toStatus: "suspended",
    note: opts.reason ?? "Suspended by admin",
    actorId: session.userId,
    actorName: session.name,
  })
  return (await getSubscriptionView(s.id))!
}

export async function resumeSubscription(id: number, session: SessionPayload): Promise<SubscriptionView> {
  const s = await loadOwned(id)
  if (s.status !== "suspended")
    throw new SubscriptionError("Only a suspended subscription can be resumed.", 409)
  // Resuming without payment returns to the dunning ladder based on dates; if
  // the period is still valid it becomes active again.
  const now = today()
  const stillValid = s.current_period_end >= now
  const status: SubscriptionStatus = stillValid ? "active" : "grace"
  await tenantUpdate("saas_subscriptions", { status }, "id = ?", [s.id])
  await logEvent({
    subscriptionId: s.id,
    subscriptionNo: s.subscription_no,
    eventType: "resumed",
    fromStatus: s.status,
    toStatus: status,
    note: "Resumed by admin",
    actorId: session.userId,
    actorName: session.name,
  })
  return (await getSubscriptionView(s.id))!
}

export type UpdateSubscriptionInput = {
  auto_renew?: boolean
  seats?: number | string | null
}

export async function updateSubscription(
  id: number,
  input: UpdateSubscriptionInput,
  session: SessionPayload,
): Promise<SubscriptionView> {
  const s = await loadOwned(id)
  if (isTerminal(s.status)) throw new SubscriptionError("Cannot modify a terminal subscription.", 409)
  const set: Record<string, any> = {}
  if (input.auto_renew !== undefined) set.auto_renew = input.auto_renew ? 1 : 0
  if (input.seats !== undefined)
    set.seats = input.seats === null || input.seats === ("" as any) ? null : num(input.seats)
  if (Object.keys(set).length === 0) return (await getSubscriptionView(s.id))!
  await tenantUpdate("saas_subscriptions", set, "id = ?", [s.id])
  await logEvent({
    subscriptionId: s.id,
    subscriptionNo: s.subscription_no,
    eventType: "updated",
    fromStatus: s.status,
    toStatus: s.status,
    note: `Updated ${Object.keys(set).join(", ")}`,
    actorId: session.userId,
    actorName: session.name,
  })
  return (await getSubscriptionView(s.id))!
}

/**
 * Reconcile every subscription for the CURRENT tenant (must be called inside a
 * tenant context, e.g. runForTenant from the cron sweep). Returns a per-tenant
 * transition tally.
 */
export async function reconcileCurrentTenant(): Promise<{ scanned: number; changed: number }> {
  await ensureSubscriptionSchema()
  const rows = (await tenantSelect("saas_subscriptions", {
    where: "status NOT IN ('cancelled','expired')",
  })) as any[]
  const now = today()
  let changed = 0
  for (const row of rows) {
    const s = mapSubscription(row)
    const before = s.status
    const after = await applyReconcile(s, now, null)
    if (after.status !== before || after.current_period_end !== s.current_period_end) changed++
  }
  return { scanned: rows.length, changed }
}
