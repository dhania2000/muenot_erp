import "server-only"
import { query } from "@/lib/db"
import { ensureContractTables } from "@/lib/legal-contracts-db"
import { logContractEvent } from "@/lib/legal-contracts-audit"
import { notify } from "@/lib/sales/lead-lifecycle"

// ---------------------------------------------------------------------------
// Legal Contracts — unattended lifecycle scheduler (server-only, Phases 45-52).
//
// Run daily via Vercel Cron (see vercel.json → /api/cron/contracts). Every pass
// is IDEMPOTENT: each reminder that has already fired is recorded in
// legal_contract_reminders keyed by a deterministic dedupe key, so a second run
// on the same day (or an accidental double trigger) never double-notifies.
//
// It performs four jobs:
//   1. Auto-expire generated contracts whose end_date has passed.
//   2. Expiry reminders at 30/15/7/3/1 days before end_date.
//   3. Renewal reminders at 30/15/7/3/1 days before renewal_date.
//   4. Review reminders for templates whose review_date is due/approaching.
//   5. Approval reminders for contracts/templates stuck In Review.
//
// Reminders reuse the existing in-app notification store (notify → the shared
// notifications table) and are also written to the contract audit trail.
// ---------------------------------------------------------------------------

const REMINDER_OFFSETS = [30, 15, 7, 3, 1] as const
const APPROVAL_STALE_DAYS = 3

export type SchedulerResult = {
  expired: number
  expiryReminders: number
  renewalReminders: number
  reviewReminders: number
  approvalReminders: number
}

let ledgerEnsured: Promise<void> | null = null

/** Idempotently create the reminder ledger used for dedupe. */
export function ensureReminderLedger(): Promise<void> {
  if (!ledgerEnsured) ledgerEnsured = doEnsureLedger()
  return ledgerEnsured
}

async function doEnsureLedger() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS legal_contract_reminders (
      dedupe_key VARCHAR(190) NOT NULL,
      kind VARCHAR(40) NOT NULL,
      entity_id BIGINT UNSIGNED NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (dedupe_key),
      KEY idx_legal_reminder_kind (kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureReminderLedger failed:", (error as Error).message)
  }
}

/**
 * Claim a reminder. Returns true only the FIRST time a given dedupe key is
 * seen — subsequent calls (re-runs) return false so nothing is re-sent.
 */
async function claimReminder(dedupeKey: string, kind: string, entityId: number | null): Promise<boolean> {
  try {
    const res = await query<{ affectedRows?: number }>(
      "INSERT IGNORE INTO legal_contract_reminders (dedupe_key, kind, entity_id) VALUES (?,?,?)",
      [dedupeKey, kind, entityId],
    )
    return Number((res as any)?.affectedRows || 0) > 0
  } catch (error) {
    console.error("[v0] claimReminder failed:", (error as Error).message)
    return false
  }
}

function daysUntil(date: string | Date | null): number | null {
  if (!date) return null
  const d = new Date(date)
  if (isNaN(d.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  d.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - today.getTime()) / 86_400_000)
}

function isoDay(date: string | Date | null): string {
  if (!date) return ""
  const d = new Date(date)
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
}

/** The main entry point invoked by the cron route. */
export async function runContractScheduler(): Promise<SchedulerResult> {
  await ensureContractTables()
  await ensureReminderLedger()

  const result: SchedulerResult = {
    expired: 0,
    expiryReminders: 0,
    renewalReminders: 0,
    reviewReminders: 0,
    approvalReminders: 0,
  }

  const ACTIVEISH = ["Draft", "Generated", "In Review", "Approved", "Sent", "Viewed", "Signed", "Active"]

  // --- 1. Auto-expire contracts past their end date -----------------------
  const overdue = await query<any[]>(
    `SELECT id, contract_uid, reference_no, title, end_date, generated_by
       FROM legal_generated_contracts
      WHERE end_date IS NOT NULL AND end_date < CURDATE()
        AND status NOT IN ('Expired','Terminated','Cancelled')`,
  ).catch(() => [])
  for (const c of overdue) {
    try {
      await query("UPDATE legal_generated_contracts SET status = 'Expired' WHERE id = ?", [c.id])
      await logContractEvent({
        entity: "contract",
        entityId: Number(c.id),
        entityRef: c.reference_no || c.contract_uid,
        type: "contract_status_changed",
        summary: `Auto-expired (end date ${isoDay(c.end_date)} passed)`,
        detail: { from: "active", to: "Expired", auto: true },
      })
      await notifyOwner(c.generated_by, {
        title: `Contract ${c.reference_no || c.contract_uid} expired`,
        body: `"${c.title}" reached its end date and was marked Expired.`,
        entityId: c.id,
      })
      result.expired++
    } catch (error) {
      console.error("[v0] auto-expire failed:", (error as Error).message)
    }
  }

  // --- 2. Expiry reminders -------------------------------------------------
  const expiring = await query<any[]>(
    `SELECT id, contract_uid, reference_no, title, end_date, generated_by
       FROM legal_generated_contracts
      WHERE end_date IS NOT NULL AND end_date >= CURDATE()
        AND end_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        AND status IN (${ACTIVEISH.map(() => "?").join(",")})`,
    ACTIVEISH,
  ).catch(() => [])
  for (const c of expiring) {
    const d = daysUntil(c.end_date)
    if (d == null) continue
    const offset = REMINDER_OFFSETS.find((o) => o === d)
    if (!offset) continue
    const key = `expiry:${c.id}:${isoDay(c.end_date)}:${offset}`
    if (!(await claimReminder(key, "expiry", Number(c.id)))) continue
    await logContractEvent({
      entity: "contract",
      entityId: Number(c.id),
      entityRef: c.reference_no || c.contract_uid,
      type: "reminder_sent",
      summary: `Expiry reminder — ${offset} day${offset === 1 ? "" : "s"} to end date`,
      detail: { kind: "expiry", daysBefore: offset, endDate: isoDay(c.end_date) },
    })
    await notifyOwner(c.generated_by, {
      title: `Contract expiring in ${offset} day${offset === 1 ? "" : "s"}`,
      body: `"${c.title}" (${c.reference_no || c.contract_uid}) ends on ${isoDay(c.end_date)}.`,
      entityId: c.id,
    })
    result.expiryReminders++
  }

  // --- 3. Renewal reminders ------------------------------------------------
  const renewing = await query<any[]>(
    `SELECT id, contract_uid, reference_no, title, renewal_date, generated_by
       FROM legal_generated_contracts
      WHERE renewal_date IS NOT NULL AND renewal_date >= CURDATE()
        AND renewal_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        AND status IN (${ACTIVEISH.map(() => "?").join(",")})`,
    ACTIVEISH,
  ).catch(() => [])
  for (const c of renewing) {
    const d = daysUntil(c.renewal_date)
    if (d == null) continue
    const offset = REMINDER_OFFSETS.find((o) => o === d)
    if (!offset) continue
    const key = `renewal:${c.id}:${isoDay(c.renewal_date)}:${offset}`
    if (!(await claimReminder(key, "renewal", Number(c.id)))) continue
    await logContractEvent({
      entity: "contract",
      entityId: Number(c.id),
      entityRef: c.reference_no || c.contract_uid,
      type: "reminder_sent",
      summary: `Renewal reminder — ${offset} day${offset === 1 ? "" : "s"} to renewal date`,
      detail: { kind: "renewal", daysBefore: offset, renewalDate: isoDay(c.renewal_date) },
    })
    await notifyOwner(c.generated_by, {
      title: `Contract renewal due in ${offset} day${offset === 1 ? "" : "s"}`,
      body: `"${c.title}" (${c.reference_no || c.contract_uid}) is up for renewal on ${isoDay(c.renewal_date)}.`,
      entityId: c.id,
    })
    result.renewalReminders++
  }

  // --- 4. Template review reminders ---------------------------------------
  const reviews = await query<any[]>(
    `SELECT id, template_uid, name, review_date, owner_id, created_by
       FROM legal_contract_templates
      WHERE review_date IS NOT NULL
        AND review_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        AND status NOT IN ('Archived','Expired')`,
  ).catch(() => [])
  for (const t of reviews) {
    const d = daysUntil(t.review_date)
    if (d == null) continue
    // Fire at each offset while approaching, and once on/after the due date.
    const isOffset = d > 0 && (REMINDER_OFFSETS as readonly number[]).includes(d)
    if (d > 0 && !isOffset) continue
    const bucket = d <= 0 ? "due" : String(d)
    const key = `review:${t.id}:${isoDay(t.review_date)}:${bucket}`
    if (!(await claimReminder(key, "review", Number(t.id)))) continue
    await logContractEvent({
      entity: "template",
      entityId: Number(t.id),
      entityRef: t.template_uid,
      type: "reminder_sent",
      summary: d <= 0 ? "Template review is due" : `Template review in ${d} day${d === 1 ? "" : "s"}`,
      detail: { kind: "review", daysBefore: d <= 0 ? 0 : d, reviewDate: isoDay(t.review_date) },
    })
    await notifyOwner(t.owner_id || t.created_by, {
      title: d <= 0 ? "Template review due" : `Template review in ${d} days`,
      body: `Template "${t.name}" is scheduled for review on ${isoDay(t.review_date)}.`,
      entityId: t.id,
      link: "/modules/legal/templates",
    })
    result.reviewReminders++
  }

  // --- 5. Approval reminders (stuck In Review) ----------------------------
  const today = isoDay(new Date())
  const stuckContracts = await query<any[]>(
    `SELECT id, contract_uid, reference_no, title, generated_by
       FROM legal_generated_contracts
      WHERE status = 'In Review'
        AND updated_at <= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [APPROVAL_STALE_DAYS],
  ).catch(() => [])
  for (const c of stuckContracts) {
    const key = `approval:contract:${c.id}:${today}`
    if (!(await claimReminder(key, "approval", Number(c.id)))) continue
    await logContractEvent({
      entity: "contract",
      entityId: Number(c.id),
      entityRef: c.reference_no || c.contract_uid,
      type: "reminder_sent",
      summary: `Approval pending for more than ${APPROVAL_STALE_DAYS} days`,
      detail: { kind: "approval" },
    })
    await notifyOwner(c.generated_by, {
      title: "Contract approval pending",
      body: `"${c.title}" (${c.reference_no || c.contract_uid}) has been awaiting approval for a while.`,
      entityId: c.id,
    })
    result.approvalReminders++
  }

  const stuckTemplates = await query<any[]>(
    `SELECT id, template_uid, name, owner_id, created_by
       FROM legal_contract_templates
      WHERE status = 'In Review'
        AND updated_at <= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [APPROVAL_STALE_DAYS],
  ).catch(() => [])
  for (const t of stuckTemplates) {
    const key = `approval:template:${t.id}:${today}`
    if (!(await claimReminder(key, "approval", Number(t.id)))) continue
    await logContractEvent({
      entity: "template",
      entityId: Number(t.id),
      entityRef: t.template_uid,
      type: "reminder_sent",
      summary: `Template approval pending for more than ${APPROVAL_STALE_DAYS} days`,
      detail: { kind: "approval" },
    })
    await notifyOwner(t.owner_id || t.created_by, {
      title: "Template approval pending",
      body: `Template "${t.name}" has been awaiting approval for a while.`,
      entityId: t.id,
      link: "/modules/legal/templates",
    })
    result.approvalReminders++
  }

  return result
}

async function notifyOwner(
  userId: number | null | undefined,
  opts: { title: string; body: string; entityId: number | string; link?: string },
) {
  if (!userId) return
  try {
    await notify(null, {
      userId: Number(userId),
      type: "contract",
      title: opts.title,
      body: opts.body,
      link: opts.link ?? "/modules/legal/contracts",
      entityType: "legal_contract",
      entityId: opts.entityId,
    })
  } catch (error) {
    console.error("[v0] contract notifyOwner failed:", (error as Error).message)
  }
}
