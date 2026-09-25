import "server-only"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { notify } from "@/lib/sales/lead-lifecycle"
import type { SessionPayload } from "@/lib/auth"
import { listEmployees } from "@/lib/employee-assets"

/**
 * Company Subscriptions — SaaS / license / recurring-service register.
 * ---------------------------------------------------------------------------
 * Tracks every recurring company subscription (SaaS tools, licenses, cloud
 * services, memberships) with its vendor (Finance → Customers/Vendors master),
 * cost, billing cycle, renewal / expiry dates, seat allocation to HR employees,
 * full renewal & audit history, documents and lifecycle (Active → Trial →
 * Suspended → Cancelled / Expired).
 *
 * Sources of truth referenced (never duplicated):
 *   customers_vendors.party_id  ←  company_subscriptions.vendor_party_id
 *   hr_employees.id             ←  subscription_seat_assignments.employee_id
 *
 * Seat integrity: a seat may have at most ONE active assignment per employee
 * per subscription (UNIQUE index on active_seat_key), and total active seats
 * can never exceed the subscription's licensed seat count (row-locked check).
 */

// ── Domain constants ─────────────────────────────────────────────────────────

export const SUBSCRIPTION_STATUSES = ["Active", "Trial", "Suspended", "Cancelled", "Expired"] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export const BILLING_CYCLES = ["Monthly", "Quarterly", "Half-Yearly", "Annual", "One-Time"] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export const SUBSCRIPTION_CATEGORIES = [
  "Software / SaaS",
  "Cloud / Hosting",
  "License",
  "Membership",
  "Domain",
  "Telecom / Internet",
  "Maintenance / AMC",
  "Other",
] as const

/** Statuses in which a subscription is considered "live" (consuming budget). */
export const LIVE_STATUSES: SubscriptionStatus[] = ["Active", "Trial"]

/** Default number of days before end date to start reminding. */
const DEFAULT_REMINDER_DAYS = 14

export const PERMISSION_KEY = "assets.company_subscriptions"
const MODULE_LINK = "/modules/assets/company-subscriptions"

// ── Schema (self-healing) ────────────────────────────────────────────────────

let schemaEnsured = false

export async function ensureSubscriptionSchema(): Promise<void> {
  if (schemaEnsured) return

  await query(`CREATE TABLE IF NOT EXISTS subscription_services (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    service_code  VARCHAR(30) NOT NULL,
    name          VARCHAR(190) NOT NULL,
    category      VARCHAR(60) DEFAULT NULL,
    website       VARCHAR(255) DEFAULT NULL,
    notes         TEXT DEFAULT NULL,
    created_by    INT UNSIGNED DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_service_code (service_code),
    UNIQUE KEY uq_service_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS company_subscriptions (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    subscription_id   VARCHAR(30) NOT NULL,
    service_name      VARCHAR(190) NOT NULL,
    service_id        INT UNSIGNED DEFAULT NULL,
    category          VARCHAR(60) DEFAULT NULL,
    vendor_party_id   VARCHAR(40) DEFAULT NULL,
    vendor_name       VARCHAR(190) DEFAULT NULL,
    plan_name         VARCHAR(120) DEFAULT NULL,
    description       TEXT DEFAULT NULL,
    billing_cycle     VARCHAR(20) NOT NULL DEFAULT 'Monthly',
    currency          VARCHAR(10) NOT NULL DEFAULT 'INR',
    amount            DECIMAL(14,2) NOT NULL DEFAULT 0,
    seats_total       INT UNSIGNED NOT NULL DEFAULT 0,
    auto_renew        TINYINT(1) NOT NULL DEFAULT 1,
    start_date        DATE DEFAULT NULL,
    end_date          DATE DEFAULT NULL,
    trial_end_date    DATE DEFAULT NULL,
    cancellation_date DATE DEFAULT NULL,
    payment_method    VARCHAR(60) DEFAULT NULL,
    account_email     VARCHAR(190) DEFAULT NULL,
    owner_user_id     INT UNSIGNED DEFAULT NULL,
    owner_name        VARCHAR(190) DEFAULT NULL,
    department        VARCHAR(120) DEFAULT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'Active',
    reminder_days     INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_REMINDER_DAYS},
    last_reminder_key VARCHAR(60) DEFAULT NULL,
    notes             TEXT DEFAULT NULL,
    created_by        INT UNSIGNED DEFAULT NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_subscription_id (subscription_id),
    KEY idx_sub_status (status),
    KEY idx_sub_vendor (vendor_party_id),
    KEY idx_sub_end (end_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS subscription_seat_assignments (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
    seat_id          VARCHAR(30) NOT NULL,
    subscription_id  VARCHAR(30) NOT NULL,
    employee_id      INT UNSIGNED NOT NULL,
    employee_ref     VARCHAR(40) DEFAULT NULL,
    employee_name    VARCHAR(190) DEFAULT NULL,
    department       VARCHAR(120) DEFAULT NULL,
    assigned_date    DATE NOT NULL,
    revoked_date     DATE DEFAULT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'Active',
    active_seat_key  VARCHAR(80) DEFAULT NULL,
    remarks          VARCHAR(255) DEFAULT NULL,
    assigned_by      INT UNSIGNED DEFAULT NULL,
    assigned_by_name VARCHAR(190) DEFAULT NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_seat_id (seat_id),
    UNIQUE KEY uq_active_seat (active_seat_key),
    KEY idx_seat_sub (subscription_id),
    KEY idx_seat_emp (employee_id),
    KEY idx_seat_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS subscription_renewals (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    subscription_id   VARCHAR(30) NOT NULL,
    action            VARCHAR(30) NOT NULL,
    previous_end_date DATE DEFAULT NULL,
    new_end_date      DATE DEFAULT NULL,
    amount            DECIMAL(14,2) DEFAULT NULL,
    currency          VARCHAR(10) DEFAULT NULL,
    billing_cycle     VARCHAR(20) DEFAULT NULL,
    remarks           VARCHAR(255) DEFAULT NULL,
    performed_by      INT UNSIGNED DEFAULT NULL,
    performed_by_name VARCHAR(190) DEFAULT NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_ren_sub (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS subscription_audit (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    subscription_id VARCHAR(30) DEFAULT NULL,
    action          VARCHAR(40) NOT NULL,
    user_id         INT UNSIGNED DEFAULT NULL,
    user_name       VARCHAR(190) DEFAULT NULL,
    old_value       TEXT DEFAULT NULL,
    new_value       TEXT DEFAULT NULL,
    reason          VARCHAR(255) DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_saudit_sub (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS subscription_documents (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    subscription_id VARCHAR(30) NOT NULL,
    doc_type        VARCHAR(60) DEFAULT NULL,
    label           VARCHAR(190) DEFAULT NULL,
    file_url        VARCHAR(600) NOT NULL,
    file_name       VARCHAR(255) DEFAULT NULL,
    uploaded_by     INT UNSIGNED DEFAULT NULL,
    uploaded_by_name VARCHAR(190) DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sdoc_sub (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  schemaEnsured = true
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10)
const dateOf = (v: any) => (v ? String(v).slice(0, 10) : null)
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const bool = (v: any) => (v === true || v === 1 || v === "1" || v === "true" ? 1 : 0)

function isValidDate(v: any): boolean {
  if (!v) return false
  return Number.isFinite(Date.parse(String(v)))
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN
  return Math.round((b - a) / 86_400_000)
}

/** Advance a date by one billing cycle (used by renew). */
export function advanceByCycle(dateStr: string, cycle: BillingCycle): string {
  const d = new Date(dateStr + "T00:00:00Z")
  switch (cycle) {
    case "Monthly":
      d.setUTCMonth(d.getUTCMonth() + 1)
      break
    case "Quarterly":
      d.setUTCMonth(d.getUTCMonth() + 3)
      break
    case "Half-Yearly":
      d.setUTCMonth(d.getUTCMonth() + 6)
      break
    case "Annual":
      d.setUTCFullYear(d.getUTCFullYear() + 1)
      break
    case "One-Time":
    default:
      break
  }
  return d.toISOString().slice(0, 10)
}

/** Normalised monthly cost for a subscription's billing cycle (for analytics). */
export function monthlyCost(amount: number, cycle: string): number {
  switch (cycle) {
    case "Monthly":
      return amount
    case "Quarterly":
      return amount / 3
    case "Half-Yearly":
      return amount / 6
    case "Annual":
      return amount / 12
    case "One-Time":
    default:
      return 0
  }
}

export function annualCost(amount: number, cycle: string): number {
  return monthlyCost(amount, cycle) * 12
}

/**
 * Derive the effective (display) status from stored status + dates. A stored
 * "Active"/"Trial" record may actually be Expired or Expiring Soon based on
 * its end date. Terminal statuses (Cancelled) are returned as-is.
 */
export function effectiveStatus(row: {
  status: string
  end_date?: string | null
  trial_end_date?: string | null
  reminder_days?: number | null
}): { status: string; expiring_soon: boolean; days_to_expiry: number | null } {
  const stored = String(row.status)
  if (stored === "Cancelled" || stored === "Suspended") {
    return { status: stored, expiring_soon: false, days_to_expiry: null }
  }
  const end = dateOf(row.end_date)
  const days = end ? daysBetween(today(), end) : null
  if (days != null && Number.isFinite(days)) {
    if (days < 0) return { status: "Expired", expiring_soon: false, days_to_expiry: days }
    const lead = row.reminder_days ?? DEFAULT_REMINDER_DAYS
    if (days <= lead) return { status: stored, expiring_soon: true, days_to_expiry: days }
    return { status: stored, expiring_soon: false, days_to_expiry: days }
  }
  return { status: stored, expiring_soon: false, days_to_expiry: null }
}

export class SubscriptionError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export async function recordAudit(input: {
  subscriptionId?: string | null
  action: string
  userId?: number | null
  userName?: string | null
  oldValue?: any
  newValue?: any
  reason?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO subscription_audit
       (subscription_id, action, user_id, user_name, old_value, new_value, reason)
     VALUES (?,?,?,?,?,?,?)`,
    [
      input.subscriptionId ?? null,
      input.action,
      input.userId ?? null,
      input.userName ?? null,
      input.oldValue != null ? JSON.stringify(input.oldValue) : null,
      input.newValue != null ? JSON.stringify(input.newValue) : null,
      input.reason ?? null,
    ],
  ).catch((e) => console.log("[v0] subscription audit insert failed", (e as Error).message))
}

async function recordRenewal(input: {
  subscriptionId: string
  action: string
  previousEndDate?: string | null
  newEndDate?: string | null
  amount?: number | null
  currency?: string | null
  billingCycle?: string | null
  remarks?: string | null
  session: SessionPayload
}): Promise<void> {
  await query(
    `INSERT INTO subscription_renewals
       (subscription_id, action, previous_end_date, new_end_date, amount, currency, billing_cycle, remarks, performed_by, performed_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      input.subscriptionId,
      input.action,
      input.previousEndDate ?? null,
      input.newEndDate ?? null,
      input.amount ?? null,
      input.currency ?? null,
      input.billingCycle ?? null,
      input.remarks ?? null,
      input.session.userId,
      input.session.name ?? null,
    ],
  ).catch((e) => console.log("[v0] subscription renewal insert failed", (e as Error).message))
}

async function notifyOwner(
  ownerUserId: number | null | undefined,
  input: { title: string; body: string; type?: string; entityId?: string | null },
): Promise<void> {
  if (!ownerUserId) return
  await notify(null, {
    userId: ownerUserId,
    type: input.type ?? "subscription",
    title: input.title,
    body: input.body,
    link: MODULE_LINK,
    entityType: "company_subscription",
    entityId: input.entityId ?? null,
  }).catch(() => {})
}

// ── Lookups (Vendors + Employees + Departments + Services) ────────────────────

export type VendorLookupRow = {
  party_id: string
  name: string | null
  contact_person: string | null
  email: string | null
  mobile: string | null
}

/** Finance Customers/Vendors master, restricted to vendor-type parties. */
export async function listVendors(search?: string | null): Promise<VendorLookupRow[]> {
  const args: any[] = []
  let searchSql = ""
  if (search && search.trim()) {
    const like = `%${search.trim()}%`
    searchSql = ` AND (customer_name LIKE ? OR legal_name LIKE ? OR party_id LIKE ?)`
    args.push(like, like, like)
  }
  const rows = (await query(
    `SELECT party_id, customer_name, legal_name, contact_person, official_email, invoice_email, mobile
       FROM customers_vendors
      WHERE (party_type IS NULL OR party_type LIKE '%Vendor%' OR party_type LIKE '%Supplier%' OR party_type LIKE '%Both%')
        AND (status IS NULL OR status = 'Active')
        ${searchSql}
      ORDER BY customer_name ASC
      LIMIT 1000`,
    args,
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    party_id: String(r.party_id),
    name: r.customer_name || r.legal_name || null,
    contact_person: r.contact_person ?? null,
    email: r.official_email || r.invoice_email || null,
    mobile: r.mobile ?? null,
  }))
}

/** Distinct active departments from HR employee master. */
export async function listDepartments(): Promise<string[]> {
  const rows = (await query(
    `SELECT DISTINCT department FROM hr_employees
      WHERE archived_at IS NULL AND department IS NOT NULL AND department <> ''
      ORDER BY department ASC`,
  ).catch(() => [])) as any[]
  return rows.map((r) => String(r.department))
}

export { listEmployees }

export type ServiceRow = {
  id: number
  service_code: string
  name: string
  category: string | null
  website: string | null
}

export async function listServices(search?: string | null): Promise<ServiceRow[]> {
  await ensureSubscriptionSchema()
  const args: any[] = []
  let searchSql = ""
  if (search && search.trim()) {
    const like = `%${search.trim()}%`
    searchSql = ` WHERE name LIKE ? OR category LIKE ?`
    args.push(like, like)
  }
  const rows = (await query(
    `SELECT id, service_code, name, category, website FROM subscription_services ${searchSql} ORDER BY name ASC LIMIT 500`,
    args,
  ).catch(() => [])) as any[]
  return rows.map((r) => ({
    id: Number(r.id),
    service_code: String(r.service_code),
    name: String(r.name),
    category: r.category ?? null,
    website: r.website ?? null,
  }))
}

export async function createService(
  input: { name: string; category?: string | null; website?: string | null; notes?: string | null },
  session: SessionPayload,
): Promise<ServiceRow> {
  await ensureSubscriptionSchema()
  const name = String(input.name || "").trim()
  if (!name) throw new SubscriptionError("Service name is required.")
  const existing = (await query(`SELECT id, service_code, name, category, website FROM subscription_services WHERE name = ? LIMIT 1`, [
    name,
  ])) as any[]
  if (existing.length) {
    const r = existing[0]
    return { id: Number(r.id), service_code: String(r.service_code), name: r.name, category: r.category ?? null, website: r.website ?? null }
  }
  const code = await nextRecordId("SVC", { digits: 5, allowCustom: true })
  await query(
    `INSERT INTO subscription_services (service_code, name, category, website, notes, created_by) VALUES (?,?,?,?,?,?)`,
    [code, name, input.category ?? null, input.website ?? null, input.notes ?? null, session.userId],
  )
  return { id: 0, service_code: code, name, category: input.category ?? null, website: input.website ?? null }
}

// ── Create / Update ────────────────────────────────────────────────────────────

export type SubscriptionInput = {
  service_name?: string
  service_id?: number | null
  category?: string | null
  vendor_party_id?: string | null
  vendor_name?: string | null
  plan_name?: string | null
  description?: string | null
  billing_cycle?: string
  currency?: string
  amount?: number | string
  seats_total?: number | string
  auto_renew?: boolean
  start_date?: string | null
  end_date?: string | null
  trial_end_date?: string | null
  payment_method?: string | null
  account_email?: string | null
  owner_user_id?: number | null
  owner_name?: string | null
  department?: string | null
  status?: string
  reminder_days?: number | string
  notes?: string | null
}

function validateInput(input: SubscriptionInput, partial = false) {
  if (!partial || input.service_name !== undefined) {
    if (!String(input.service_name || "").trim()) throw new SubscriptionError("Service name is required.")
  }
  if (input.billing_cycle !== undefined && !BILLING_CYCLES.includes(input.billing_cycle as BillingCycle))
    throw new SubscriptionError("Invalid billing cycle.")
  if (input.status !== undefined && !SUBSCRIPTION_STATUSES.includes(input.status as SubscriptionStatus))
    throw new SubscriptionError("Invalid status.")
  if (input.amount !== undefined && num(input.amount) < 0) throw new SubscriptionError("Amount cannot be negative.")
  if (input.seats_total !== undefined && Number(input.seats_total) < 0)
    throw new SubscriptionError("Seat count cannot be negative.")
  for (const [k, v] of [
    ["start_date", input.start_date],
    ["end_date", input.end_date],
    ["trial_end_date", input.trial_end_date],
  ] as const) {
    if (v && !isValidDate(v)) throw new SubscriptionError(`${k.replace(/_/g, " ")} is invalid.`)
  }
  if (input.start_date && input.end_date && dateOf(input.end_date)! < dateOf(input.start_date)!)
    throw new SubscriptionError("End date cannot be before the start date.")
}

export async function createSubscription(input: SubscriptionInput, session: SessionPayload) {
  await ensureSubscriptionSchema()
  validateInput(input)

  const status = (input.status as SubscriptionStatus) || "Active"
  const subscriptionId = await nextRecordId("SUB", { digits: 6, allowCustom: true })

  await query(
    `INSERT INTO company_subscriptions
       (subscription_id, service_name, service_id, category, vendor_party_id, vendor_name, plan_name, description,
        billing_cycle, currency, amount, seats_total, auto_renew, start_date, end_date, trial_end_date,
        payment_method, account_email, owner_user_id, owner_name, department, status, reminder_days, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      subscriptionId,
      String(input.service_name).trim(),
      input.service_id ?? null,
      input.category ?? null,
      input.vendor_party_id ?? null,
      input.vendor_name ?? null,
      input.plan_name ?? null,
      input.description ?? null,
      input.billing_cycle ?? "Monthly",
      input.currency ?? "INR",
      num(input.amount),
      Math.max(0, Math.trunc(num(input.seats_total))),
      input.auto_renew === undefined ? 1 : bool(input.auto_renew),
      dateOf(input.start_date) ?? today(),
      dateOf(input.end_date),
      dateOf(input.trial_end_date),
      input.payment_method ?? null,
      input.account_email ?? null,
      input.owner_user_id ?? null,
      input.owner_name ?? null,
      input.department ?? null,
      status,
      Math.max(0, Math.trunc(num(input.reminder_days ?? DEFAULT_REMINDER_DAYS))),
      input.notes ?? null,
      session.userId,
    ],
  )

  await recordAudit({
    subscriptionId,
    action: "created",
    userId: session.userId,
    userName: session.name,
    newValue: { service_name: input.service_name, status, amount: num(input.amount) },
  })
  await recordRenewal({
    subscriptionId,
    action: "Create",
    newEndDate: dateOf(input.end_date),
    amount: num(input.amount),
    currency: input.currency ?? "INR",
    billingCycle: input.billing_cycle ?? "Monthly",
    session,
  })
  await notifyOwner(input.owner_user_id, {
    title: "Subscription assigned to you",
    body: `You are now the owner of the "${input.service_name}" subscription (${subscriptionId}).`,
    entityId: subscriptionId,
  })

  return await getSubscriptionDetail(subscriptionId)
}

export async function updateSubscription(subscriptionId: string, input: SubscriptionInput, session: SessionPayload) {
  await ensureSubscriptionSchema()
  const current = await loadSubscription(subscriptionId)
  if (!current) throw new SubscriptionError("Subscription not found.", 404)
  validateInput(input, true)

  const fields: string[] = []
  const args: any[] = []
  const map: Record<string, any> = {
    service_name: input.service_name !== undefined ? String(input.service_name).trim() : undefined,
    service_id: input.service_id,
    category: input.category,
    vendor_party_id: input.vendor_party_id,
    vendor_name: input.vendor_name,
    plan_name: input.plan_name,
    description: input.description,
    billing_cycle: input.billing_cycle,
    currency: input.currency,
    amount: input.amount !== undefined ? num(input.amount) : undefined,
    seats_total: input.seats_total !== undefined ? Math.max(0, Math.trunc(num(input.seats_total))) : undefined,
    auto_renew: input.auto_renew !== undefined ? bool(input.auto_renew) : undefined,
    start_date: input.start_date !== undefined ? dateOf(input.start_date) : undefined,
    end_date: input.end_date !== undefined ? dateOf(input.end_date) : undefined,
    trial_end_date: input.trial_end_date !== undefined ? dateOf(input.trial_end_date) : undefined,
    payment_method: input.payment_method,
    account_email: input.account_email,
    owner_user_id: input.owner_user_id,
    owner_name: input.owner_name,
    department: input.department,
    status: input.status,
    reminder_days: input.reminder_days !== undefined ? Math.max(0, Math.trunc(num(input.reminder_days))) : undefined,
    notes: input.notes,
  }
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) continue
    fields.push(`${k} = ?`)
    args.push(v)
  }
  if (input.seats_total !== undefined) {
    const activeSeats = await countActiveSeats(subscriptionId)
    if (Number(map.seats_total) < activeSeats)
      throw new SubscriptionError(
        `Cannot reduce seats to ${map.seats_total}: ${activeSeats} seat(s) are currently assigned. Revoke seats first.`,
        409,
      )
  }
  if (!fields.length) return await getSubscriptionDetail(subscriptionId)

  args.push(subscriptionId)
  await query(`UPDATE company_subscriptions SET ${fields.join(", ")} WHERE subscription_id = ?`, args)

  await recordAudit({
    subscriptionId,
    action: "updated",
    userId: session.userId,
    userName: session.name,
    oldValue: { status: current.status, amount: num(current.amount), seats_total: current.seats_total },
    newValue: map,
  })
  return await getSubscriptionDetail(subscriptionId)
}

export async function deleteSubscription(subscriptionId: string, session: SessionPayload) {
  await ensureSubscriptionSchema()
  const current = await loadSubscription(subscriptionId)
  if (!current) throw new SubscriptionError("Subscription not found.", 404)
  const active = await countActiveSeats(subscriptionId)
  if (active > 0) throw new SubscriptionError(`Cannot delete: ${active} active seat(s). Revoke seats first.`, 409)
  await query(`DELETE FROM company_subscriptions WHERE subscription_id = ?`, [subscriptionId])
  await recordAudit({
    subscriptionId,
    action: "deleted",
    userId: session.userId,
    userName: session.name,
    oldValue: { service_name: current.service_name, status: current.status },
  })
  return { ok: true }
}

// ── Lifecycle: renew / cancel / suspend / reactivate ──────────────────────────

export type RenewalInput = { new_end_date?: string | null; amount?: number | string | null; remarks?: string | null }

const MAX_RENEWAL_AMOUNT = 1_000_000_000

/**
 * Resolve and validate the terms of a renewal against the current row. Shared
 * by the renewal-approval request (to freeze the terms an approver sees) and by
 * the apply step, so the two can never disagree.
 */
export function computeRenewalTerms(current: any, input: RenewalInput) {
  if (current.status === "Cancelled") throw new SubscriptionError("A cancelled subscription cannot be renewed.", 409)
  if (input.new_end_date && !isValidDate(input.new_end_date)) throw new SubscriptionError("New end date is invalid.")
  const previousEnd = dateOf(current.end_date)
  const cycle = current.billing_cycle as BillingCycle
  const base = previousEnd && previousEnd >= today() ? previousEnd : today()
  const newEnd = dateOf(input.new_end_date) || (cycle === "One-Time" ? previousEnd : advanceByCycle(base, cycle))
  if (!newEnd) throw new SubscriptionError("A new end date is required for a one-time subscription.")
  if (previousEnd && newEnd < previousEnd)
    throw new SubscriptionError("New end date cannot be earlier than the current end date.")
  const rawAmount = input.amount === undefined || input.amount === null || input.amount === "" ? current.amount : input.amount
  const amount = num(rawAmount)
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_RENEWAL_AMOUNT)
    throw new SubscriptionError("Renewal amount must be between 0 and 1,000,000,000.")
  return { previousEnd, newEnd, amount: Math.round(amount * 100) / 100 }
}

/**
 * Apply a renewal. Called by the renewal-approval workflow once a checker has
 * approved the request — not directly by the API, so a renewal (which commits
 * company spend) always passes maker-checker review first.
 */
export async function renewSubscription(subscriptionId: string, input: RenewalInput, session: SessionPayload) {
  await ensureSubscriptionSchema()
  const current = await loadSubscription(subscriptionId)
  if (!current) throw new SubscriptionError("Subscription not found.", 404)

  const { newEnd, amount } = computeRenewalTerms(current, input)

  await query(
    `UPDATE company_subscriptions SET end_date = ?, amount = ?, status = 'Active', last_reminder_key = NULL WHERE subscription_id = ?`,
    [newEnd, amount, subscriptionId],
  )
  await recordRenewal({
    subscriptionId,
    action: "Renew",
    previousEndDate: dateOf(current.end_date),
    newEndDate: newEnd,
    amount,
    currency: current.currency,
    billingCycle: current.billing_cycle,
    remarks: input.remarks ?? null,
    session,
  })
  await recordAudit({
    subscriptionId,
    action: "renewed",
    userId: session.userId,
    userName: session.name,
    oldValue: { end_date: dateOf(current.end_date) },
    newValue: { end_date: newEnd, amount },
    reason: input.remarks ?? null,
  })
  await notifyOwner(current.owner_user_id, {
    title: "Subscription renewed",
    body: `"${current.service_name}" renewed until ${newEnd}.`,
    entityId: subscriptionId,
  })
  return await getSubscriptionDetail(subscriptionId)
}

async function transition(
  subscriptionId: string,
  target: SubscriptionStatus,
  action: string,
  input: { remarks?: string | null; effective_date?: string | null },
  session: SessionPayload,
) {
  await ensureSubscriptionSchema()
  const current = await loadSubscription(subscriptionId)
  if (!current) throw new SubscriptionError("Subscription not found.", 404)
  if (current.status === target) throw new SubscriptionError(`Subscription is already ${target}.`, 409)

  const extra =
    target === "Cancelled" ? `, cancellation_date = ?, auto_renew = 0` : ""
  const args: any[] = [target]
  if (target === "Cancelled") args.push(dateOf(input.effective_date) || today())
  args.push(subscriptionId)

  await query(`UPDATE company_subscriptions SET status = ?${extra} WHERE subscription_id = ?`, args)

  await recordRenewal({
    subscriptionId,
    action,
    previousEndDate: dateOf(current.end_date),
    newEndDate: dateOf(current.end_date),
    remarks: input.remarks ?? null,
    session,
  })
  await recordAudit({
    subscriptionId,
    action: action.toLowerCase(),
    userId: session.userId,
    userName: session.name,
    oldValue: { status: current.status },
    newValue: { status: target },
    reason: input.remarks ?? null,
  })
  await notifyOwner(current.owner_user_id, {
    title: `Subscription ${target.toLowerCase()}`,
    body: `"${current.service_name}" was ${target.toLowerCase()}.`,
    entityId: subscriptionId,
  })
  return await getSubscriptionDetail(subscriptionId)
}

export const cancelSubscription = (id: string, input: { remarks?: string | null; effective_date?: string | null }, s: SessionPayload) =>
  transition(id, "Cancelled", "Cancel", input, s)
export const suspendSubscription = (id: string, input: { remarks?: string | null }, s: SessionPayload) =>
  transition(id, "Suspended", "Suspend", input, s)
export const reactivateSubscription = (id: string, input: { remarks?: string | null }, s: SessionPayload) =>
  transition(id, "Active", "Reactivate", input, s)

// ── Seat assignment ────────────────────────────────────────────────────────────

async function countActiveSeats(subscriptionId: string): Promise<number> {
  const rows = (await query(
    `SELECT COUNT(*) AS c FROM subscription_seat_assignments WHERE subscription_id = ? AND status = 'Active'`,
    [subscriptionId],
  )) as any[]
  return Number(rows[0]?.c || 0)
}

export async function assignSeat(
  subscriptionId: string,
  input: { employee_id?: number | string; assigned_date?: string | null; remarks?: string | null },
  session: SessionPayload,
) {
  await ensureSubscriptionSchema()
  const employeeId = Number(input.employee_id)
  if (!employeeId) throw new SubscriptionError("Please select an employee.")
  const assignedDate = dateOf(input.assigned_date) || today()
  if (input.assigned_date && !isValidDate(input.assigned_date))
    throw new SubscriptionError("Assigned date is invalid.")

  const seatId = await nextRecordId("SBS", { digits: 6, allowCustom: true })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Lock the subscription and validate seat availability.
    const [subRows] = await conn.query<any[]>(
      `SELECT subscription_id, service_name, seats_total, status FROM company_subscriptions WHERE subscription_id = ? LIMIT 1 FOR UPDATE`,
      [subscriptionId],
    )
    const sub = subRows[0]
    if (!sub) throw new SubscriptionError("Subscription not found.", 404)
    if (["Cancelled", "Expired"].includes(String(sub.status)))
      throw new SubscriptionError(`Cannot assign seats on a ${sub.status} subscription.`, 409)

    const [countRows] = await conn.query<any[]>(
      `SELECT COUNT(*) AS c FROM subscription_seat_assignments WHERE subscription_id = ? AND status = 'Active' FOR UPDATE`,
      [subscriptionId],
    )
    const used = Number(countRows[0]?.c || 0)
    const total = Number(sub.seats_total || 0)
    if (total > 0 && used >= total)
      throw new SubscriptionError(`All ${total} seat(s) are already assigned.`, 409)

    // Validate employee exists / active.
    const [empRows] = await conn.query<any[]>(
      `SELECT id, employee_id, employee_name, department, employment_status FROM hr_employees WHERE id = ? AND archived_at IS NULL LIMIT 1`,
      [employeeId],
    )
    const emp = empRows[0]
    if (!emp) throw new SubscriptionError("Selected employee no longer exists.", 404)

    await conn.query(
      `INSERT INTO subscription_seat_assignments
         (seat_id, subscription_id, employee_id, employee_ref, employee_name, department,
          assigned_date, status, active_seat_key, remarks, assigned_by, assigned_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        seatId,
        subscriptionId,
        employeeId,
        emp.employee_id ?? null,
        emp.employee_name ?? null,
        emp.department ?? null,
        assignedDate,
        "Active",
        `${subscriptionId}:${employeeId}`,
        input.remarks ?? null,
        session.userId,
        session.name ?? null,
      ],
    )
    await conn.commit()

    await recordAudit({
      subscriptionId,
      action: "seat_assigned",
      userId: session.userId,
      userName: session.name,
      newValue: { seat_id: seatId, employee_id: employeeId, employee_name: emp.employee_name },
    })
    return await getSubscriptionDetail(subscriptionId)
  } catch (error: any) {
    await conn.rollback().catch(() => {})
    if (error?.code === "ER_DUP_ENTRY")
      throw new SubscriptionError("This employee already holds an active seat on this subscription.", 409)
    throw error
  } finally {
    conn.release()
  }
}

export async function revokeSeat(
  subscriptionId: string,
  seatId: string,
  input: { revoked_date?: string | null; remarks?: string | null },
  session: SessionPayload,
) {
  await ensureSubscriptionSchema()
  const rows = (await query(
    `SELECT * FROM subscription_seat_assignments WHERE seat_id = ? AND subscription_id = ? LIMIT 1`,
    [seatId, subscriptionId],
  )) as any[]
  const seat = rows[0]
  if (!seat) throw new SubscriptionError("Seat assignment not found.", 404)
  if (seat.status !== "Active") throw new SubscriptionError("This seat is already revoked.", 409)
  const revokedDate = dateOf(input.revoked_date) || today()

  await query(
    `UPDATE subscription_seat_assignments
        SET status = 'Revoked', revoked_date = ?, active_seat_key = NULL, remarks = COALESCE(?, remarks)
      WHERE seat_id = ?`,
    [revokedDate, input.remarks ?? null, seatId],
  )
  await recordAudit({
    subscriptionId,
    action: "seat_revoked",
    userId: session.userId,
    userName: session.name,
    oldValue: { seat_id: seatId, employee_name: seat.employee_name },
    newValue: { revoked_date: revokedDate },
    reason: input.remarks ?? null,
  })
  return await getSubscriptionDetail(subscriptionId)
}

// ── Documents ──────────────────────────────────────────────────────────────────

export async function addDocument(
  subscriptionId: string,
  input: { file_url: string; file_name?: string | null; doc_type?: string | null; label?: string | null },
  session: SessionPayload,
) {
  await ensureSubscriptionSchema()
  if (!input.file_url) throw new SubscriptionError("A file URL is required.")
  const sub = await loadSubscription(subscriptionId)
  if (!sub) throw new SubscriptionError("Subscription not found.", 404)
  await query(
    `INSERT INTO subscription_documents (subscription_id, doc_type, label, file_url, file_name, uploaded_by, uploaded_by_name)
     VALUES (?,?,?,?,?,?,?)`,
    [
      subscriptionId,
      input.doc_type ?? null,
      input.label ?? null,
      input.file_url,
      input.file_name ?? null,
      session.userId,
      session.name ?? null,
    ],
  )
  await recordAudit({
    subscriptionId,
    action: "document_added",
    userId: session.userId,
    userName: session.name,
    newValue: { label: input.label, file_name: input.file_name },
  })
  return await getSubscriptionDetail(subscriptionId)
}

export async function deleteDocument(subscriptionId: string, docId: number, session: SessionPayload) {
  await ensureSubscriptionSchema()
  await query(`DELETE FROM subscription_documents WHERE id = ? AND subscription_id = ?`, [docId, subscriptionId])
  await recordAudit({ subscriptionId, action: "document_removed", userId: session.userId, userName: session.name })
  return await getSubscriptionDetail(subscriptionId)
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function loadSubscription(subscriptionId: string): Promise<any | null> {
  const rows = (await query(`SELECT * FROM company_subscriptions WHERE subscription_id = ? LIMIT 1`, [
    subscriptionId,
  ])) as any[]
  return rows[0] ?? null
}

function shapeRow(r: any, activeSeats: number) {
  const eff = effectiveStatus(r)
  return {
    subscription_id: String(r.subscription_id),
    service_name: r.service_name,
    service_id: r.service_id ? Number(r.service_id) : null,
    category: r.category ?? null,
    vendor_party_id: r.vendor_party_id ?? null,
    vendor_name: r.vendor_name ?? null,
    plan_name: r.plan_name ?? null,
    description: r.description ?? null,
    billing_cycle: r.billing_cycle,
    currency: r.currency,
    amount: num(r.amount),
    monthly_cost: monthlyCost(num(r.amount), r.billing_cycle),
    annual_cost: annualCost(num(r.amount), r.billing_cycle),
    seats_total: Number(r.seats_total || 0),
    seats_used: activeSeats,
    seats_available: Math.max(0, Number(r.seats_total || 0) - activeSeats),
    auto_renew: !!r.auto_renew,
    start_date: dateOf(r.start_date),
    end_date: dateOf(r.end_date),
    trial_end_date: dateOf(r.trial_end_date),
    cancellation_date: dateOf(r.cancellation_date),
    payment_method: r.payment_method ?? null,
    account_email: r.account_email ?? null,
    owner_user_id: r.owner_user_id ? Number(r.owner_user_id) : null,
    owner_name: r.owner_name ?? null,
    department: r.department ?? null,
    status: r.status,
    effective_status: eff.status,
    expiring_soon: eff.expiring_soon,
    days_to_expiry: eff.days_to_expiry,
    reminder_days: Number(r.reminder_days ?? DEFAULT_REMINDER_DAYS),
    notes: r.notes ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export type ListFilters = {
  search?: string | null
  status?: string | null
  category?: string | null
  vendor?: string | null
  department?: string | null
  billing_cycle?: string | null
  expiring?: boolean
  sort?: string | null
  dir?: "asc" | "desc" | null
}

const SORT_COLUMNS: Record<string, string> = {
  service_name: "service_name",
  amount: "amount",
  end_date: "end_date",
  start_date: "start_date",
  status: "status",
  created_at: "created_at",
  vendor_name: "vendor_name",
}

export async function listSubscriptions(filters: ListFilters = {}) {
  await ensureSubscriptionSchema()
  const where: string[] = []
  const args: any[] = []

  if (filters.search && filters.search.trim()) {
    const like = `%${filters.search.trim()}%`
    where.push(`(service_name LIKE ? OR vendor_name LIKE ? OR subscription_id LIKE ? OR plan_name LIKE ?)`)
    args.push(like, like, like, like)
  }
  if (filters.status && filters.status !== "all") {
    where.push(`status = ?`)
    args.push(filters.status)
  }
  if (filters.category && filters.category !== "all") {
    where.push(`category = ?`)
    args.push(filters.category)
  }
  if (filters.vendor && filters.vendor !== "all") {
    where.push(`vendor_party_id = ?`)
    args.push(filters.vendor)
  }
  if (filters.department && filters.department !== "all") {
    where.push(`department = ?`)
    args.push(filters.department)
  }
  if (filters.billing_cycle && filters.billing_cycle !== "all") {
    where.push(`billing_cycle = ?`)
    args.push(filters.billing_cycle)
  }

  const sortCol = SORT_COLUMNS[filters.sort ?? ""] ?? "created_at"
  const dir = filters.dir === "asc" ? "ASC" : "DESC"
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const rows = (await query(
    `SELECT s.*, (SELECT COUNT(*) FROM subscription_seat_assignments a WHERE a.subscription_id = s.subscription_id AND a.status = 'Active') AS active_seats
       FROM company_subscriptions s ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT 2000`,
    args,
  )) as any[]

  let shaped = rows.map((r) => shapeRow(r, Number(r.active_seats || 0)))
  if (filters.expiring) shaped = shaped.filter((r) => r.expiring_soon || r.effective_status === "Expired")

  return { rows: shaped, summary: computeSummary(shaped) }
}

function computeSummary(rows: ReturnType<typeof shapeRow>[]) {
  const summary = {
    total: rows.length,
    active: 0,
    trial: 0,
    suspended: 0,
    cancelled: 0,
    expired: 0,
    expiring_soon: 0,
    seats_total: 0,
    seats_used: 0,
    monthly_spend: 0,
    annual_spend: 0,
  }
  for (const r of rows) {
    if (r.effective_status === "Active") summary.active++
    else if (r.effective_status === "Trial") summary.trial++
    else if (r.effective_status === "Suspended") summary.suspended++
    else if (r.effective_status === "Cancelled") summary.cancelled++
    else if (r.effective_status === "Expired") summary.expired++
    if (r.expiring_soon) summary.expiring_soon++
    summary.seats_total += r.seats_total
    summary.seats_used += r.seats_used
    if (LIVE_STATUSES.includes(r.effective_status as SubscriptionStatus)) {
      summary.monthly_spend += r.monthly_cost
      summary.annual_spend += r.annual_cost
    }
  }
  summary.monthly_spend = Math.round(summary.monthly_spend * 100) / 100
  summary.annual_spend = Math.round(summary.annual_spend * 100) / 100
  return summary
}

export async function getSubscriptionDetail(subscriptionId: string) {
  await ensureSubscriptionSchema()
  const row = await loadSubscription(subscriptionId)
  if (!row) return null
  const activeSeats = await countActiveSeats(subscriptionId)

  const seats = (await query(
    `SELECT seat_id, employee_id, employee_ref, employee_name, department, assigned_date, revoked_date, status, remarks, assigned_by_name
       FROM subscription_seat_assignments WHERE subscription_id = ? ORDER BY (status='Active') DESC, assigned_date DESC`,
    [subscriptionId],
  )) as any[]
  const renewals = (await query(
    `SELECT action, previous_end_date, new_end_date, amount, currency, billing_cycle, remarks, performed_by_name, created_at
       FROM subscription_renewals WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 100`,
    [subscriptionId],
  )) as any[]
  const audit = (await query(
    `SELECT action, user_name, reason, created_at FROM subscription_audit WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 100`,
    [subscriptionId],
  )) as any[]
  const documents = (await query(
    `SELECT id, doc_type, label, file_url, file_name, uploaded_by_name, created_at
       FROM subscription_documents WHERE subscription_id = ? ORDER BY created_at DESC`,
    [subscriptionId],
  )) as any[]

  return {
    subscription: shapeRow(row, activeSeats),
    seats: seats.map((s) => ({
      seat_id: String(s.seat_id),
      employee_id: Number(s.employee_id),
      employee_ref: s.employee_ref ?? null,
      employee_name: s.employee_name ?? null,
      department: s.department ?? null,
      assigned_date: dateOf(s.assigned_date),
      revoked_date: dateOf(s.revoked_date),
      status: s.status,
      remarks: s.remarks ?? null,
      assigned_by_name: s.assigned_by_name ?? null,
    })),
    renewals: renewals.map((r) => ({
      action: r.action,
      previous_end_date: dateOf(r.previous_end_date),
      new_end_date: dateOf(r.new_end_date),
      amount: r.amount != null ? num(r.amount) : null,
      currency: r.currency ?? null,
      billing_cycle: r.billing_cycle ?? null,
      remarks: r.remarks ?? null,
      performed_by_name: r.performed_by_name ?? null,
      created_at: r.created_at,
    })),
    audit,
    documents: documents.map((d) => ({
      id: Number(d.id),
      doc_type: d.doc_type ?? null,
      label: d.label ?? null,
      file_url: d.file_url,
      file_name: d.file_name ?? null,
      uploaded_by_name: d.uploaded_by_name ?? null,
      created_at: d.created_at,
    })),
  }
}

// ── Analytics ──────────────────────────────────────────────────────────────────

export async function getAnalytics() {
  const { rows, summary } = await listSubscriptions({})
  const live = rows.filter((r) => LIVE_STATUSES.includes(r.effective_status as SubscriptionStatus))

  const groupSpend = (key: "category" | "vendor_name" | "department") => {
    const map = new Map<string, number>()
    for (const r of live) {
      const k = (r[key] as string) || "Unspecified"
      map.set(k, (map.get(k) || 0) + r.monthly_cost)
    }
    return Array.from(map.entries())
      .map(([label, monthly]) => ({ label, monthly: Math.round(monthly * 100) / 100, annual: Math.round(monthly * 12 * 100) / 100 }))
      .sort((a, b) => b.monthly - a.monthly)
  }

  const upcoming = rows
    .filter((r) => r.end_date && (r.expiring_soon || (r.days_to_expiry != null && r.days_to_expiry >= 0 && r.days_to_expiry <= 60)))
    .filter((r) => r.effective_status !== "Cancelled")
    .sort((a, b) => (a.days_to_expiry ?? 9999) - (b.days_to_expiry ?? 9999))
    .slice(0, 25)
    .map((r) => ({
      subscription_id: r.subscription_id,
      service_name: r.service_name,
      vendor_name: r.vendor_name,
      end_date: r.end_date,
      days_to_expiry: r.days_to_expiry,
      amount: r.amount,
      currency: r.currency,
      auto_renew: r.auto_renew,
    }))

  return {
    summary,
    by_category: groupSpend("category"),
    by_vendor: groupSpend("vendor_name"),
    by_department: groupSpend("department"),
    upcoming_renewals: upcoming,
  }
}

// ── CSV export (no secrets — account_email excluded) ──────────────────────────

export async function exportCsv(filters: ListFilters = {}): Promise<string> {
  const { rows } = await listSubscriptions(filters)
  const headers = [
    "Subscription ID",
    "Service",
    "Category",
    "Vendor",
    "Plan",
    "Billing Cycle",
    "Currency",
    "Amount",
    "Monthly Cost",
    "Annual Cost",
    "Seats Total",
    "Seats Used",
    "Auto Renew",
    "Start Date",
    "End Date",
    "Status",
    "Owner",
    "Department",
  ]
  const esc = (v: any) => {
    const s = v == null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        r.subscription_id,
        r.service_name,
        r.category,
        r.vendor_name,
        r.plan_name,
        r.billing_cycle,
        r.currency,
        r.amount,
        Math.round(r.monthly_cost * 100) / 100,
        Math.round(r.annual_cost * 100) / 100,
        r.seats_total,
        r.seats_used,
        r.auto_renew ? "Yes" : "No",
        r.start_date,
        r.end_date,
        r.effective_status,
        r.owner_name,
        r.department,
      ]
        .map(esc)
        .join(","),
    )
  }
  return lines.join("\n")
}

// ── Cron: renewal / expiry / trial reminders (idempotent per day) ─────────────

export async function runSubscriptionReminders(): Promise<{ scanned: number; notified: number }> {
  await ensureSubscriptionSchema()
  const rows = (await query(
    `SELECT * FROM company_subscriptions WHERE status IN ('Active','Trial')`,
  )) as any[]

  let notified = 0
  const stamp = today()

  for (const r of rows) {
    const end = dateOf(r.end_date)
    const trialEnd = dateOf(r.trial_end_date)
    const lead = Number(r.reminder_days ?? DEFAULT_REMINDER_DAYS)

    let kind: string | null = null
    let message: string | null = null

    if (end) {
      const d = daysBetween(stamp, end)
      if (d < 0) {
        kind = "expired"
        message = `"${r.service_name}" expired on ${end}.`
      } else if (d <= lead) {
        kind = "renewal"
        message = `"${r.service_name}" renews/expires in ${d} day(s) on ${end}.`
      }
    }
    if (!kind && r.status === "Trial" && trialEnd) {
      const d = daysBetween(stamp, trialEnd)
      if (d >= 0 && d <= lead) {
        kind = "trial"
        message = `Trial for "${r.service_name}" ends in ${d} day(s) on ${trialEnd}.`
      }
    }
    if (!kind) continue

    // Idempotency: one notification per subscription per kind per day.
    const reminderKey = `${kind}:${stamp}`
    if (r.last_reminder_key === reminderKey) continue

    await query(`UPDATE company_subscriptions SET last_reminder_key = ? WHERE subscription_id = ?`, [
      reminderKey,
      r.subscription_id,
    ])

    // Auto-flip to Expired so status stays accurate even without a page load.
    if (kind === "expired" && r.status !== "Expired") {
      await query(`UPDATE company_subscriptions SET status = 'Expired' WHERE subscription_id = ?`, [r.subscription_id])
      await recordAudit({ subscriptionId: r.subscription_id, action: "auto_expired", newValue: { status: "Expired" } })
    }

    if (r.owner_user_id) {
      await notifyOwner(Number(r.owner_user_id), {
        title:
          kind === "expired"
            ? "Subscription expired"
            : kind === "trial"
              ? "Trial ending soon"
              : "Subscription renewal due",
        body: message!,
        type: `subscription-${kind}`,
        entityId: r.subscription_id,
      })
      notified++
    }
  }

  return { scanned: rows.length, notified }
}
