import "server-only"
import { query } from "@/lib/db"
import { tenantSelect, tenantInsert, tenantUpdate } from "@/lib/tenant-scope"
import type { SessionPayload } from "@/lib/auth"
import { sendEmail, isEmailConfigured, hydrateDepartmentSMTP } from "@/lib/email"
import {
  addTerm,
  normalizeLifecycleConfig,
  toISODate,
  type BillingTerm,
  type LifecycleConfig,
  type SubscriptionStatus,
} from "@/lib/billing/subscription-lifecycle"
import {
  listSubscriptions,
  getSummary,
  reconcileCurrentTenant,
  type SubscriptionView,
} from "@/lib/billing/subscription-engine"
import { generateSubscriptionInvoice } from "@/lib/billing/billing-engine"
import {
  dueReminder,
  nextRetry,
  plannedRetryCount,
  REMINDER_LABELS,
  type DueReminder,
  type ReminderKind,
} from "@/lib/billing/renewal-schedule"

/**
 * SPEC 24 — Renewal management engine (data + service layer).
 * ---------------------------------------------------------------------------
 * Phases 2 & 3: turns the pure schedule (renewal-schedule.ts) into a running,
 * tenant-scoped renewal cycle. A single `runRenewalCycle` pass:
 *   1. reconciles the lifecycle (auto-renew roll-forward, dunning, expiry — SPEC 16)
 *   2. queues + delivers the due renewal reminder for each subscription
 *   3. attempts failed-payment retries for lapsed renewals, escalating to
 *      suspension once the retry schedule is exhausted
 *   4. ensures a renewal invoice exists for each billable period (SPEC 20)
 *
 * The cycle is idempotent: reminders are keyed on (subscription, period, kind)
 * and retries on (subscription, period, attempt_no), so re-running it — whether
 * from the console button or the /api/billing/run cron — never double-sends or
 * double-charges. Every write goes through the tenant-scope helpers, so the
 * cycle can only ever touch the caller's own tenant (fail-closed, SPEC 2).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type RenewalReminder = {
  id: number
  subscription_id: number
  subscription_no: string
  reminder_kind: ReminderKind
  reminder_label: string
  period_end: string
  due_date: string
  channel: "email" | "log"
  status: "sent" | "logged" | "failed"
  recipient: string | null
  note: string | null
  sent_at: string | null
  created_at: string
}

export type RenewalAttempt = {
  id: number
  subscription_id: number
  subscription_no: string
  attempt_no: number
  period_end: string
  scheduled_for: string
  status: "succeeded" | "failed" | "exhausted"
  amount: number
  currency: string
  gateway: string | null
  invoice_no: string | null
  error: string | null
  processed_at: string | null
  created_at: string
}

export type RenewalCycleResult = {
  scanned: number
  lifecycle_changed: number
  reminders_queued: number
  reminders_sent: number
  retries_attempted: number
  retries_succeeded: number
  suspended: number
  invoices_generated: number
}

export type RenewalOverview = {
  subscriptions: SubscriptionView[]
  summary: Awaited<ReturnType<typeof getSummary>>
  reminders: RenewalReminder[]
  attempts: RenewalAttempt[]
}

/**
 * Result of attempting to collect a failed renewal payment. Injectable so the
 * gateway registry (SPEC 21) can be wired in later; the default reflects that
 * this environment has no stored payment instrument to charge.
 */
export type RenewalChargeResult = {
  ok: boolean
  gateway: string | null
  reference: string | null
  error: string | null
}
export type RenewalChargeFn = (sub: LiteSubscription, attemptNo: number) => Promise<RenewalChargeResult>

const defaultCharge: RenewalChargeFn = async () => ({
  ok: false,
  gateway: null,
  reference: null,
  error: "No stored payment method on file — record a manual payment to renew.",
})

// ── Schema ────────────────────────────────────────────────────────────────

let schemaEnsured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS saas_renewal_reminders (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id       INT UNSIGNED NOT NULL,
    subscription_id INT UNSIGNED NOT NULL,
    subscription_no VARCHAR(30) DEFAULT NULL,
    reminder_kind   VARCHAR(30) NOT NULL,
    period_end      DATE NOT NULL,
    due_date        DATE NOT NULL,
    channel         VARCHAR(20) NOT NULL DEFAULT 'log',
    status          VARCHAR(20) NOT NULL DEFAULT 'logged',
    recipient       VARCHAR(190) DEFAULT NULL,
    note            VARCHAR(255) DEFAULT NULL,
    sent_at         DATETIME DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_renewal_reminder (tenant_id, subscription_id, reminder_kind, period_end),
    KEY idx_renewal_reminder_tenant (tenant_id),
    KEY idx_renewal_reminder_sub (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS saas_renewal_attempts (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id       INT UNSIGNED NOT NULL,
    subscription_id INT UNSIGNED NOT NULL,
    subscription_no VARCHAR(30) DEFAULT NULL,
    attempt_no      INT UNSIGNED NOT NULL DEFAULT 1,
    period_end      DATE NOT NULL,
    scheduled_for   DATE NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'failed',
    amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
    gateway         VARCHAR(40) DEFAULT NULL,
    invoice_no      VARCHAR(30) DEFAULT NULL,
    error           VARCHAR(255) DEFAULT NULL,
    processed_at    DATETIME DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_renewal_attempt (tenant_id, subscription_id, period_end, attempt_no),
    KEY idx_renewal_attempt_tenant (tenant_id),
    KEY idx_renewal_attempt_sub (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

export async function ensureRenewalSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = runEnsure().catch((err) => {
      schemaEnsured = null
      throw err
    })
  }
  return schemaEnsured
}

// ── Helpers ──────────────────────────────────────────────────────────────

const today = () => toISODate(new Date())
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ")
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const bool = (v: any) => v === true || v === 1 || v === "1" || v === "true"
const dateOf = (v: any) => (v ? String(v).slice(0, 10) : null)

type LiteSubscription = {
  id: number
  subscription_no: string
  plan_name: string
  term: BillingTerm
  amount: number
  currency: string
  status: SubscriptionStatus
  auto_renew: boolean
  cancel_at_period_end: boolean
  current_period_start: string
  current_period_end: string
  renewal_count: number
  config: LifecycleConfig
}

function mapLite(r: any): LiteSubscription {
  return {
    id: Number(r.id),
    subscription_no: String(r.subscription_no),
    plan_name: String(r.plan_name),
    term: String(r.term) as BillingTerm,
    amount: num(r.amount),
    currency: String(r.currency || "USD"),
    status: String(r.status) as SubscriptionStatus,
    auto_renew: bool(r.auto_renew),
    cancel_at_period_end: bool(r.cancel_at_period_end),
    current_period_start: dateOf(r.current_period_start) ?? today(),
    current_period_end: dateOf(r.current_period_end) ?? today(),
    renewal_count: num(r.renewal_count),
    config: normalizeLifecycleConfig({
      pastDueDays: num(r.past_due_days),
      graceDays: num(r.grace_days),
      suspendDays: num(r.suspend_days),
    }),
  }
}

function mapReminder(r: any): RenewalReminder {
  const kind = String(r.reminder_kind) as ReminderKind
  return {
    id: Number(r.id),
    subscription_id: Number(r.subscription_id),
    subscription_no: String(r.subscription_no ?? ""),
    reminder_kind: kind,
    reminder_label: REMINDER_LABELS[kind] ?? kind,
    period_end: dateOf(r.period_end) ?? "",
    due_date: dateOf(r.due_date) ?? "",
    channel: (r.channel === "email" ? "email" : "log") as "email" | "log",
    status: String(r.status) as RenewalReminder["status"],
    recipient: r.recipient ?? null,
    note: r.note ?? null,
    sent_at: r.sent_at ? String(r.sent_at) : null,
    created_at: String(r.created_at ?? ""),
  }
}

function mapAttempt(r: any): RenewalAttempt {
  return {
    id: Number(r.id),
    subscription_id: Number(r.subscription_id),
    subscription_no: String(r.subscription_no ?? ""),
    attempt_no: num(r.attempt_no),
    period_end: dateOf(r.period_end) ?? "",
    scheduled_for: dateOf(r.scheduled_for) ?? "",
    status: String(r.status) as RenewalAttempt["status"],
    amount: num(r.amount),
    currency: String(r.currency || "USD"),
    gateway: r.gateway ?? null,
    invoice_no: r.invoice_no ?? null,
    error: r.error ?? null,
    processed_at: r.processed_at ? String(r.processed_at) : null,
    created_at: String(r.created_at ?? ""),
  }
}

/** Append a subscription audit event (mirrors the SPEC 16 event log). */
async function logEvent(
  sub: LiteSubscription,
  eventType: string,
  fields: {
    fromStatus?: SubscriptionStatus | null
    toStatus?: SubscriptionStatus | null
    note?: string | null
  } = {},
): Promise<void> {
  await tenantInsert("saas_subscription_events", {
    subscription_id: sub.id,
    subscription_no: sub.subscription_no,
    event_type: eventType,
    from_status: fields.fromStatus ?? null,
    to_status: fields.toStatus ?? null,
    amount: sub.amount,
    currency: sub.currency,
    period_start: sub.current_period_start,
    period_end: sub.current_period_end,
    note: fields.note ?? null,
    actor_id: null,
    actor_name: "Renewal automation",
  }).catch((e) => console.log("[v0] renewal event log failed", (e as Error).message))
}

/** Best-effort recipient: the bill-to email of the subscription's latest invoice. */
async function resolveRecipient(subscriptionId: number): Promise<string | null> {
  try {
    const rows = (await tenantSelect("billing_invoices", {
      columns: "bill_to_email",
      where: "subscription_id = ? AND bill_to_email IS NOT NULL AND bill_to_email <> ''",
      params: [subscriptionId],
      tail: "ORDER BY created_at DESC LIMIT 1",
    })) as any[]
    return rows[0]?.bill_to_email ? String(rows[0].bill_to_email) : null
  } catch {
    return null
  }
}

// ── Reminder persistence + delivery ─────────────────────────────────────────

async function sentReminderKinds(subscriptionId: number, periodEnd: string): Promise<ReminderKind[]> {
  const rows = (await tenantSelect("saas_renewal_reminders", {
    columns: "reminder_kind",
    where: "subscription_id = ? AND period_end = ?",
    params: [subscriptionId, periodEnd],
  })) as any[]
  return rows.map((r) => String(r.reminder_kind) as ReminderKind)
}

function reminderEmail(sub: LiteSubscription, reminder: DueReminder): { subject: string; html: string } {
  const label = REMINDER_LABELS[reminder.kind] ?? reminder.kind
  const money = `${sub.currency} ${sub.amount.toFixed(2)}`
  const subject = `${label} — ${sub.plan_name} (${sub.subscription_no})`
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:560px">
      <h2 style="margin:0 0 8px">${label}</h2>
      <p style="margin:0 0 16px;color:#475569">${reminder.reason}.</p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 16px 4px 0;color:#64748b">Plan</td><td>${sub.plan_name}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#64748b">Reference</td><td>${sub.subscription_no}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#64748b">Amount</td><td>${money} / ${sub.term}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#64748b">Renewal date</td><td>${sub.current_period_end}</td></tr>
      </table>
    </div>`
  return { subject, html }
}

async function recordReminder(
  sub: LiteSubscription,
  reminder: DueReminder,
  opts: { send: boolean },
): Promise<{ status: RenewalReminder["status"] }> {
  const recipient = opts.send ? await resolveRecipient(sub.id) : null
  let status: RenewalReminder["status"] = "logged"
  let channel: "email" | "log" = "log"
  let sentAt: string | null = null

  let canEmail = false
  if (opts.send && recipient) {
    await hydrateDepartmentSMTP("finance").catch(() => {})
    canEmail = isEmailConfigured("finance")
  }

  if (canEmail && recipient) {
    try {
      const { subject, html } = reminderEmail(sub, reminder)
      await sendEmail({ to: recipient, subject, html, department: "finance" })
      status = "sent"
      channel = "email"
      sentAt = now()
    } catch (e) {
      status = "failed"
      channel = "email"
      console.log("[v0] renewal reminder email failed", sub.subscription_no, (e as Error).message)
    }
  }

  await tenantInsert("saas_renewal_reminders", {
    subscription_id: sub.id,
    subscription_no: sub.subscription_no,
    reminder_kind: reminder.kind,
    period_end: sub.current_period_end,
    due_date: reminder.referenceDate,
    channel,
    status,
    recipient,
    note: reminder.reason,
    sent_at: sentAt,
  }).catch((e) => console.log("[v0] renewal reminder insert failed", (e as Error).message))

  await logEvent(sub, "renewal_reminder", {
    toStatus: sub.status,
    note: `${REMINDER_LABELS[reminder.kind]} (${status})`,
  })

  return { status }
}

// ── Retry persistence + escalation ─────────────────────────────────────────

async function attemptsMadeFor(subscriptionId: number, periodEnd: string): Promise<number> {
  const rows = (await tenantSelect("saas_renewal_attempts", {
    columns: "id",
    where: "subscription_id = ? AND period_end = ? AND status IN ('failed','succeeded')",
    params: [subscriptionId, periodEnd],
  })) as any[]
  return rows.length
}

async function alreadyExhausted(subscriptionId: number, periodEnd: string): Promise<boolean> {
  const rows = (await tenantSelect("saas_renewal_attempts", {
    columns: "id",
    where: "subscription_id = ? AND period_end = ? AND status = 'exhausted'",
    params: [subscriptionId, periodEnd],
    tail: "LIMIT 1",
  })) as any[]
  return rows.length > 0
}

/** Roll the subscription forward one term after a successful retry collection. */
async function applySuccessfulRenewal(sub: LiteSubscription): Promise<void> {
  const newStart = sub.current_period_end
  const newEnd = addTerm(sub.current_period_end, sub.term)
  await tenantUpdate(
    "saas_subscriptions",
    {
      status: "active",
      current_period_start: newStart,
      current_period_end: newEnd,
      renewal_count: sub.renewal_count + 1,
      last_payment_at: now(),
      canceled_at: null,
      cancel_reason: null,
      ended_at: null,
    },
    "id = ?",
    [sub.id],
  )
  await logEvent(sub, "renewed", { fromStatus: sub.status, toStatus: "active", note: "Renewed via payment retry" })
}

async function escalateSuspend(sub: LiteSubscription): Promise<void> {
  await tenantUpdate("saas_subscriptions", { status: "suspended" }, "id = ? AND status <> 'suspended'", [sub.id])
  await tenantInsert("saas_renewal_attempts", {
    subscription_id: sub.id,
    subscription_no: sub.subscription_no,
    attempt_no: plannedRetryCount(sub.config) + 1,
    period_end: sub.current_period_end,
    scheduled_for: today(),
    status: "exhausted",
    amount: sub.amount,
    currency: sub.currency,
    gateway: null,
    invoice_no: null,
    error: "Retry schedule exhausted — subscription suspended.",
    processed_at: now(),
  }).catch((e) => console.log("[v0] renewal exhaustion insert failed", (e as Error).message))
  await logEvent(sub, "suspended", {
    fromStatus: sub.status,
    toStatus: "suspended",
    note: "Suspended after exhausting renewal payment retries",
  })
}

async function recordAttempt(
  sub: LiteSubscription,
  attemptNo: number,
  scheduledFor: string,
  result: RenewalChargeResult,
  invoiceNo: string | null,
): Promise<void> {
  await tenantInsert("saas_renewal_attempts", {
    subscription_id: sub.id,
    subscription_no: sub.subscription_no,
    attempt_no: attemptNo,
    period_end: sub.current_period_end,
    scheduled_for: scheduledFor,
    status: result.ok ? "succeeded" : "failed",
    amount: sub.amount,
    currency: sub.currency,
    gateway: result.gateway,
    invoice_no: invoiceNo,
    error: result.ok ? null : result.error,
    processed_at: now(),
  }).catch((e) => console.log("[v0] renewal attempt insert failed", (e as Error).message))
  await logEvent(sub, result.ok ? "payment_retry_succeeded" : "payment_retry_failed", {
    toStatus: sub.status,
    note: result.ok ? `Retry #${attemptNo} succeeded` : `Retry #${attemptNo} failed: ${result.error ?? "declined"}`,
  })
}

// ── Cycle orchestrator ──────────────────────────────────────────────────────

export async function runRenewalCycle(
  session: SessionPayload | null,
  opts: { taxRate?: number; charge?: RenewalChargeFn; sendReminders?: boolean } = {},
): Promise<RenewalCycleResult> {
  await ensureRenewalSchema()

  // 1. Bring the lifecycle current (auto-renew roll-forward, dunning, expiry).
  const reconcile = await reconcileCurrentTenant()

  const clock = today()
  const rows = (await tenantSelect("saas_subscriptions", {
    where: "status NOT IN ('cancelled','expired')",
  })) as any[]

  const result: RenewalCycleResult = {
    scanned: rows.length,
    lifecycle_changed: reconcile.changed,
    reminders_queued: 0,
    reminders_sent: 0,
    retries_attempted: 0,
    retries_succeeded: 0,
    suspended: 0,
    invoices_generated: 0,
  }

  const charge = opts.charge ?? defaultCharge
  const sendReminders = opts.sendReminders ?? false

  for (const row of rows) {
    const sub = mapLite(row)

    // 2. Renewal reminders — at most one per subscription per cycle.
    try {
      const sent = await sentReminderKinds(sub.id, sub.current_period_end)
      const reminder = dueReminder(
        {
          status: sub.status,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodEnd: sub.current_period_end,
          config: sub.config,
        },
        clock,
        sent,
      )
      if (reminder) {
        const { status } = await recordReminder(sub, reminder, { send: sendReminders })
        result.reminders_queued++
        if (status === "sent") result.reminders_sent++
      }
    } catch (e) {
      console.log("[v0] reminder step failed", sub.subscription_no, (e as Error).message)
    }

    // 3. Failed-payment retries for lapsed renewals in the dunning window.
    if ((sub.status === "past_due" || sub.status === "grace") && !sub.cancel_at_period_end) {
      try {
        const made = await attemptsMadeFor(sub.id, sub.current_period_end)
        const decision = nextRetry(sub.current_period_end, clock, sub.config, made)
        if (decision.exhausted) {
          if (!(await alreadyExhausted(sub.id, sub.current_period_end))) {
            await escalateSuspend(sub)
            result.suspended++
          }
        } else if (decision.due) {
          const charged = await charge(sub, decision.attemptNo)
          result.retries_attempted++

          // Ensure the renewal invoice exists for this collection attempt.
          let invoiceNo: string | null = null
          if (session) {
            try {
              const inv = await generateSubscriptionInvoice(sub.id, session, { taxRate: opts.taxRate ?? 0 })
              invoiceNo = inv.invoice.invoice_no
              if (inv.created) result.invoices_generated++
            } catch (e) {
              console.log("[v0] retry invoice ensure failed", sub.subscription_no, (e as Error).message)
            }
          }

          await recordAttempt(sub, decision.attemptNo, decision.scheduledFor, charged, invoiceNo)
          if (charged.ok) {
            await applySuccessfulRenewal(sub)
            result.retries_succeeded++
          }
        }
      } catch (e) {
        console.log("[v0] retry step failed", sub.subscription_no, (e as Error).message)
      }
      continue
    }

    // 4. Renewal invoice for good-standing subscriptions (idempotent per period).
    if (session && (sub.status === "active" || sub.status === "trial")) {
      try {
        const inv = await generateSubscriptionInvoice(sub.id, session, { taxRate: opts.taxRate ?? 0 })
        if (inv.created) result.invoices_generated++
      } catch (e) {
        console.log("[v0] renewal invoice ensure failed", sub.subscription_no, (e as Error).message)
      }
    }
  }

  return result
}

// ── Read models for the console ──────────────────────────────────────────────

export async function listReminders(limit = 100): Promise<RenewalReminder[]> {
  await ensureRenewalSchema()
  const rows = (await tenantSelect("saas_renewal_reminders", {
    tail: `ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
  })) as any[]
  return rows.map(mapReminder)
}

export async function listAttempts(limit = 100): Promise<RenewalAttempt[]> {
  await ensureRenewalSchema()
  const rows = (await tenantSelect("saas_renewal_attempts", {
    tail: `ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
  })) as any[]
  return rows.map(mapAttempt)
}

export async function getRenewalOverview(): Promise<RenewalOverview> {
  await ensureRenewalSchema()
  const [subscriptions, summary, reminders, attempts] = await Promise.all([
    listSubscriptions(),
    getSummary(),
    listReminders(50),
    listAttempts(50),
  ])
  return { subscriptions, summary, reminders, attempts }
}
