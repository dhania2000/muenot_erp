import "server-only"
import { query } from "@/lib/db"
import { notify } from "@/lib/sales/lead-lifecycle"
import { userHasFeature } from "@/lib/permissions"

/**
 * Shared plumbing for the Phase 11 Finance automation crons (Loans,
 * Investments, Related Parties). It reuses the SAME building blocks the Journal
 * / GST / TDS sweeps already use — no new scheduler and no new notification
 * surface:
 *
 *   • `financeRecipients(feature)` — every active admin plus every active
 *     employee granted that module's feature, exactly like `journalRecipients`.
 *   • a self-creating `finance_reminder_dedup` guard table + `claimReminderKey`
 *     so a repeat run on the same day never re-notifies (mirrors
 *     `journal_notification_dedup`). This is what "prevent duplicate cron
 *     posting" means for the reminder crons — the posting crons (depreciation,
 *     provisions) stay idempotent through their own unique ledger rows.
 *   • `emitReminder` — claim the key, then fan a deduped notification out to
 *     every recipient through the shared in-app bell (`sales_notifications`).
 *
 * Every step is failure-tolerant: a notification error never aborts a sweep.
 */

// ── Recipients ───────────────────────────────────────────────────────────────
export async function financeRecipients(feature: string): Promise<number[]> {
  const recipients = new Set<number>()
  const admins = (await query(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`,
  ).catch(() => [])) as any[]
  for (const a of admins) recipients.add(Number(a.id))

  const employees = (await query(
    `SELECT id FROM users WHERE role = 'employee' AND status = 'active'`,
  ).catch(() => [])) as any[]
  await Promise.all(
    employees.map(async (e) => {
      const ok = await userHasFeature(Number(e.id), "employee", feature).catch(() => false)
      if (ok) recipients.add(Number(e.id))
    }),
  )
  return Array.from(recipients)
}

// ── Notification dedup ───────────────────────────────────────────────────────
let dedupEnsured = false
async function ensureDedup() {
  if (dedupEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS finance_reminder_dedup (
      dedup_key  VARCHAR(191) NOT NULL PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  dedupEnsured = true
}

/** Claim a dedup key. Returns true only for the FIRST claim in the window. */
export async function claimReminderKey(key: string): Promise<boolean> {
  await ensureDedup()
  try {
    const res = (await query(`INSERT IGNORE INTO finance_reminder_dedup (dedup_key) VALUES (?)`, [key])) as any
    return Number(res?.affectedRows ?? 0) > 0
  } catch {
    return false
  }
}

export type Reminder = {
  key: string
  type: string
  title: string
  body: string
  link: string
  entityType: string
  entityId: string
}

/**
 * Fan a single deduped reminder out to every recipient. Returns the number of
 * bell notifications inserted (0 when the key was already claimed).
 */
export async function emitReminder(reminder: Reminder, recipients: number[]): Promise<number> {
  const fresh = await claimReminderKey(reminder.key)
  if (!fresh) return 0
  let inserted = 0
  for (const userId of recipients) {
    await notify(null, {
      userId,
      type: reminder.type,
      title: reminder.title,
      body: reminder.body,
      link: reminder.link,
      entityType: reminder.entityType,
      entityId: reminder.entityId,
    }).catch(() => {})
    inserted += 1
  }
  return inserted
}

/** Today's date as an ISO `YYYY-MM-DD` string (used inside dedup keys). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
