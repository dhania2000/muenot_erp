import "server-only"
import { query } from "@/lib/db"
import { notify } from "@/lib/sales/lead-lifecycle"
import { userHasFeature } from "@/lib/permissions"
import { computeJournalExceptions, type JournalException } from "@/lib/finance-journal-control"
import { periodKeyFor, isPeriodLocked } from "@/lib/finance-period-lock"

/**
 * Phases 58 (automation) & 59 (notifications) for Journal Entries.
 *
 * Runs on the SAME cron/scheduler shape the GST and TDS sweeps use — no new
 * scheduler. It performs the automatic checks the spec lists (unposted, pending
 * approval, source mismatch, posting failure, duplicate, period-lock issues) by
 * delegating to the read-only control engine, then pushes alerts into the SAME
 * in-app bell (`sales_notifications`) the rest of the ERP uses via notify().
 * Every alert is dedup-guarded so a repeat run on the same day never re-notifies
 * and a notification failure never aborts the sweep.
 */

const FEATURE = "journal-entries"

// ── Period helpers ───────────────────────────────────────────────────────────
function currentPeriod(ref: Date = new Date()): string {
  return `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, "0")}`
}
function previousPeriod(ref: Date = new Date()): string {
  const d = new Date(ref.getFullYear(), ref.getMonth() - 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── Recipient resolution (mirrors gstRecipients) ─────────────────────────────
// Journal alerts go to every active admin plus every active employee granted the
// Journal Entries feature — exactly the people who can act on them.
export async function journalRecipients(): Promise<number[]> {
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
      const ok = await userHasFeature(Number(e.id), "employee", FEATURE).catch(() => false)
      if (ok) recipients.add(Number(e.id))
    }),
  )
  return Array.from(recipients)
}

// ── Notification dedup ───────────────────────────────────────────────────────
// Self-creating guard table: a dedup key is claimed with INSERT IGNORE, so only
// the first claim in a window proceeds. Keys embed the alert type + period +
// day so distinct alerts and distinct days stay independent.
let dedupEnsured = false
async function ensureDedup() {
  if (dedupEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS journal_notification_dedup (
      dedup_key  VARCHAR(191) NOT NULL PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  dedupEnsured = true
}
async function claimDedupKey(key: string): Promise<boolean> {
  await ensureDedup()
  try {
    const res = (await query(`INSERT IGNORE INTO journal_notification_dedup (dedup_key) VALUES (?)`, [key])) as any
    return Number(res?.affectedRows ?? 0) > 0
  } catch {
    return false
  }
}

// The notification classes the spec asks for (Phase 59). Each maps a human
// title/body onto the recipients, keyed for dedup.
type JournalAlert = {
  key: string
  type:
    | "journal_pending"
    | "journal_rejected"
    | "journal_posting_failed"
    | "journal_unbalanced"
    | "journal_source_sync_failed"
    | "journal_period_pending"
  title: string
  body: string
  link: string
}

async function emitAlert(alert: JournalAlert): Promise<number> {
  const fresh = await claimDedupKey(alert.key)
  if (!fresh) return 0
  const recipients = await journalRecipients()
  let inserted = 0
  for (const userId of recipients) {
    await notify(null, {
      userId,
      type: "journal",
      title: alert.title,
      body: alert.body,
      link: alert.link,
      entityType: "journal_control",
      entityId: alert.key,
    }).catch(() => {})
    inserted += 1
  }
  return inserted
}

const CONTROL_LINK = "/modules/finance/journal-control"

/**
 * The automatic checks (Phase 58). A pure diagnostic pass — it never posts,
 * approves, or edits a voucher; it only detects and (below) notifies. Returns
 * the raw counts so a caller (cron response, dashboard) can show what ran.
 */
export async function runJournalChecks(period?: string | null): Promise<{
  period: string
  pendingApproval: string[]
  rejected: string[]
  unbalanced: string[]
  postingFailed: string[]
  duplicate: string[]
  sourceMismatch: string[]
  periodLockIssues: string[]
  unposted: string[]
}> {
  const key = periodKeyFor(period) || previousPeriod()

  // Status-driven checks straight from the columns.
  const rows = (await query(
    `SELECT voucher_no,
            COALESCE(MAX(approval_status), '') AS approval_status,
            COALESCE(MAX(posting_status), '')  AS posting_status
       FROM journal_entries
      WHERE voucher_no IS NOT NULL AND voucher_no <> ''
        AND DATE_FORMAT(journal_date, '%Y-%m') = ?
      GROUP BY voucher_no`,
    [key],
  )) as any[]

  const pendingApproval: string[] = []
  const rejected: string[] = []
  const unposted: string[] = []
  for (const r of rows) {
    const v = String(r.voucher_no)
    if (String(r.approval_status) === "Pending Approval") pendingApproval.push(v)
    if (String(r.approval_status) === "Rejected") rejected.push(v)
    if (String(r.posting_status) !== "Posted") unposted.push(v)
  }

  // Exception-driven checks from the control engine.
  const exceptions: JournalException[] = await computeJournalExceptions(key)
  const vFor = (code: JournalException["code"]) =>
    Array.from(new Set(exceptions.filter((e) => e.code === code).map((e) => e.voucherNo)))

  return {
    period: key,
    pendingApproval,
    rejected,
    unbalanced: vFor("Unbalanced"),
    postingFailed: vFor("PostingFailed"),
    duplicate: vFor("Duplicate"),
    sourceMismatch: vFor("MissingSource"),
    periodLockIssues: vFor("ClosedPeriod"),
    unposted,
  }
}

/**
 * Daily sweep: run the checks for the working period and raise a deduped
 * notification per non-empty finding. Safe to run repeatedly.
 */
export async function runDailyJournalSweep(targetPeriod?: string | null): Promise<{
  ran_at: string
  period: string
  checks: Awaited<ReturnType<typeof runJournalChecks>>
  notifications: number
}> {
  const period = periodKeyFor(targetPeriod) || previousPeriod()
  const day = today()
  const checks = await runJournalChecks(period)
  let notifications = 0

  const raise = async (
    list: string[],
    type: JournalAlert["type"],
    title: (n: number) => string,
    body: (n: number) => string,
  ) => {
    if (!list.length) return
    notifications += await emitAlert({
      key: `daily|${type}|${period}|${day}`,
      type,
      title: title(list.length),
      body: body(list.length),
      link: CONTROL_LINK,
    })
  }

  await raise(
    checks.pendingApproval,
    "journal_pending",
    (n) => `${n} journal${n > 1 ? "s" : ""} pending approval`,
    (n) => `${n} journal voucher${n > 1 ? "s" : ""} for ${period} are awaiting approval.`,
  )
  await raise(
    checks.rejected,
    "journal_rejected",
    (n) => `${n} journal${n > 1 ? "s" : ""} rejected`,
    (n) => `${n} journal voucher${n > 1 ? "s" : ""} for ${period} were rejected and need attention.`,
  )
  await raise(
    checks.postingFailed,
    "journal_posting_failed",
    (n) => `${n} journal posting${n > 1 ? "s" : ""} failed`,
    (n) => `${n} approved voucher${n > 1 ? "s" : ""} for ${period} did not reach the General Ledger.`,
  )
  await raise(
    checks.unbalanced,
    "journal_unbalanced",
    (n) => `${n} unbalanced journal${n > 1 ? "s" : ""}`,
    (n) => `${n} voucher${n > 1 ? "s" : ""} for ${period} have unequal debit and credit totals.`,
  )
  await raise(
    checks.sourceMismatch,
    "journal_source_sync_failed",
    (n) => `${n} journal${n > 1 ? "s" : ""} missing source`,
    (n) => `${n} posted voucher${n > 1 ? "s" : ""} for ${period} have no linked source document.`,
  )

  // Period closing pending: the working month is not yet locked but is clean of
  // blocking errors — a nudge that it is ready to close.
  const prev = previousPeriod()
  if (!(await isPeriodLocked(prev))) {
    const prevChecks = await runJournalChecks(prev)
    const blocking =
      prevChecks.unbalanced.length +
      prevChecks.postingFailed.length +
      prevChecks.pendingApproval.length +
      prevChecks.unposted.length
    if (blocking === 0) {
      notifications += await emitAlert({
        key: `daily|journal_period_pending|${prev}|${day}`,
        type: "journal_period_pending",
        title: `Period ${prev} ready to close`,
        body: `All ${prev} journals are posted, approved and balanced. Review and lock the period.`,
        link: CONTROL_LINK,
      })
    }
  }

  return { ran_at: new Date().toISOString(), period, checks, notifications }
}

/**
 * Event notifications (Phase 59) — call from the journal lifecycle when a single
 * voucher changes state so the relevant users hear about it immediately, not
 * only on the daily sweep. Deduped per voucher + event + day.
 */
export async function notifyJournalEvent(
  event: "pending" | "rejected" | "posting_failed" | "unbalanced" | "source_sync_failed",
  voucherNo: string,
  detail?: string,
): Promise<number> {
  const v = String(voucherNo || "").trim()
  if (!v) return 0
  const day = today()
  const map: Record<typeof event, { type: JournalAlert["type"]; title: string; body: string }> = {
    pending: {
      type: "journal_pending",
      title: `Journal ${v} pending approval`,
      body: detail || `Voucher ${v} has been submitted and is awaiting approval.`,
    },
    rejected: {
      type: "journal_rejected",
      title: `Journal ${v} rejected`,
      body: detail || `Voucher ${v} was rejected. Review and correct it.`,
    },
    posting_failed: {
      type: "journal_posting_failed",
      title: `Journal ${v} posting failed`,
      body: detail || `Voucher ${v} could not be posted to the General Ledger.`,
    },
    unbalanced: {
      type: "journal_unbalanced",
      title: `Journal ${v} is unbalanced`,
      body: detail || `Voucher ${v} has unequal debit and credit totals.`,
    },
    source_sync_failed: {
      type: "journal_source_sync_failed",
      title: `Journal ${v} source sync failed`,
      body: detail || `Voucher ${v} lost the link to its source document.`,
    },
  }
  const a = map[event]
  return emitAlert({ key: `event|${a.type}|${v}|${day}`, type: a.type, title: a.title, body: a.body, link: CONTROL_LINK })
}
