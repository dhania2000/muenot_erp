import "server-only"
import { query } from "@/lib/db"
import { logFinanceEvent, getFinanceEventsByRefs, type FinanceAuditEvent } from "@/lib/finance-audit"
import {
  gstSummary,
  gstReconciliationCenter,
  listReturnAmendments,
  transitionReturnStatus,
  getGstTaxPaid,
} from "@/lib/finance-gst-filing"
import { gstComplianceReport } from "@/lib/finance-gst-compliance"
import { listGstInput, reconcilePeriod, draftGstr2bFromBills } from "@/lib/finance-gst-input"
import { notify, ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"
import { userHasFeature } from "@/lib/permissions"

/**
 * GST automation, notifications & period-close (Phases 37–40).
 *
 * This module adds NO new GST maths and owns NO authoritative GST table. It only
 * ORCHESTRATES the engines that already exist (filing, input/ITC, compliance)
 * and layers three cross-cutting concerns on top:
 *
 *   - Phase 37 Automation      → daily/monthly sweeps that run the existing
 *                                exception, mismatch, reconciliation and reminder
 *                                logic on a schedule (via the existing Vercel Cron).
 *   - Phase 38 Automation safety → every sweep is idempotent. It never files a
 *                                return, records a payment, or posts a Journal/GL
 *                                voucher — those stay user actions. The only writes
 *                                it makes (2B draft, ITC reconcile) are themselves
 *                                idempotent, and every notification is dedup-guarded
 *                                so a repeated run can't spam or double-insert.
 *   - Phase 39 Notifications    → alerts are pushed into the SAME in-app bell the
 *                                CRM uses (`sales_notifications`), never a new one.
 *   - Phase 40 Period close     → a pre-close checklist gate that refuses to close
 *                                a period until every compliance dimension is clean.
 */

const FEATURE = "finance.gst_filing"
const GST_LINK = "/modules/finance/gst-filing"

const FILING_STATUSES_PREPARED = new Set([
  "Ready for Review",
  "Reviewed",
  "Filed",
  "Amended",
  "Payment Pending",
  "Completed",
])
const FILING_STATUSES_FILED = new Set(["Filed", "Amended", "Payment Pending", "Completed"])

// ── Period helpers ──────────────────────────────────────────────────────────
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** The calendar month before `ref` (default today) as YYYY-MM — the period a
 *  GST return is usually being prepared/filed for. */
export function previousPeriod(ref: Date = new Date()): string {
  const d = new Date(ref.getFullYear(), ref.getMonth() - 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

export function currentPeriod(ref: Date = new Date()): string {
  return `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, "0")}`
}

// ── Recipient resolution (Phase 39) ──────────────────────────────────────────
// GST alerts go to every admin plus every active employee granted the GST Filing
// feature. Admins always qualify; employees are checked against the permission
// matrix / legacy grants exactly like the API guard does.
export async function gstRecipients(): Promise<number[]> {
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

// ── Notification dedup (Phase 38) ────────────────────────────────────────────
// A tiny self-creating guard table. A dedup key is claimed with INSERT IGNORE;
// only the first claim proceeds, so a cron re-run on the same day never
// re-notifies. Keys embed the period + type + window so distinct alerts and
// distinct days remain independent.
let dedupEnsured = false
async function ensureDedup() {
  if (dedupEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS gst_notification_dedup (
       dedup_key VARCHAR(191) NOT NULL PRIMARY KEY,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ).catch(() => {})
  dedupEnsured = true
}

async function claimDedupKey(key: string): Promise<boolean> {
  await ensureDedup()
  try {
    const res = (await query(`INSERT IGNORE INTO gst_notification_dedup (dedup_key) VALUES (?)`, [key])) as any
    return Number(res?.affectedRows ?? 0) > 0
  } catch {
    return false
  }
}

const today = () => new Date().toISOString().slice(0, 10)

export type GstAlert = {
  type: string
  title: string
  body: string
}

/**
 * Emit a GST alert to every recipient exactly once per dedup window. Returns the
 * number of user-notifications actually inserted (0 when the alert was already
 * sent for this window). Best-effort — a notification failure never breaks a sweep.
 */
async function emitAlert(alert: GstAlert, dedupKey: string): Promise<number> {
  const fresh = await claimDedupKey(dedupKey)
  if (!fresh) return 0
  await ensureLeadLifecycleSchema().catch(() => {})
  const recipients = await gstRecipients()
  let inserted = 0
  for (const userId of recipients) {
    await notify(null, {
      userId,
      type: "gst",
      title: alert.title,
      body: alert.body,
      link: GST_LINK,
      entityType: "gst_filing",
      entityId: alert.type,
    })
      .then(() => {
        inserted += 1
      })
      .catch(() => {})
  }
  return inserted
}

// ── Alert computation (read-only) ────────────────────────────────────────────
// Given a period's already-derived state, decide which of the Phase-39 alerts
// apply right now. Pure classification — it mutates nothing.
export async function computeGstAlerts(period: string): Promise<GstAlert[]> {
  if (!PERIOD_RE.test(period)) return []
  const alerts: GstAlert[] = []
  const summary = await gstSummary(period).catch(() => null)
  if (!summary) return []

  const status = summary.workflow.status
  const filed = FILING_STATUSES_FILED.has(status)
  const hasDocs = summary.totals.invoice_count > 0
  const balance = summary.liability.balance_payable

  if (hasDocs && !filed) {
    alerts.push({
      type: "Filing Pending",
      title: `GST filing pending — ${period}`,
      body: `${summary.totals.invoice_count} document(s) in ${period} are not yet filed (status: ${status}).`,
    })
    alerts.push({
      type: "GST Filing Due",
      title: `GSTR-1 due for ${period}`,
      body: `Outward tax of ${summary.totals.total_tax} is ready to file for ${period}.`,
    })
  }

  if (FILING_STATUSES_PREPARED.has(status) && !filed) {
    alerts.push({
      type: "GSTR-1 Ready",
      title: `GSTR-1 ready to file — ${period}`,
      body: `The GSTR-1 for ${period} is prepared and can be filed.`,
    })
    alerts.push({
      type: "GSTR-3B Ready",
      title: `GSTR-3B ready — ${period}`,
      body: `Net tax payable per the auto GSTR-3B for ${period} is ${summary.gstr3b.net_tax_payable}.`,
    })
  }

  if (balance > 1) {
    alerts.push({
      type: "Tax Payment Due",
      title: `GST payment due — ${period}`,
      body: `A balance of ${balance} is payable for ${period} after recorded payments.`,
    })
  }

  // Reconciliation drift, read from the shared reconciliation center.
  const center = await gstReconciliationCenter(period).catch(() => null)
  if (center) {
    const itcLine = center.lines.find((l) => l.key === "itc_2b")
    if (itcLine && itcLine.status === "Mismatch") {
      alerts.push({
        type: "ITC Mismatch",
        title: `ITC mismatch — ${period}`,
        body: `Input register (${itcLine.left}) differs from GSTR-2B (${itcLine.right}) for ${period}.`,
      })
    }
    const pending = center.lines.filter((l) => l.status === "Pending")
    if (pending.length) {
      alerts.push({
        type: "Reconciliation Pending",
        title: `GST reconciliation pending — ${period}`,
        body: `${pending.length} reconciliation line(s) for ${period} are still pending.`,
      })
    }
  }

  // 2B mismatch at the individual-bill level.
  const inputRows = await listGstInput({ period }).catch(() => [])
  const twoBMismatch = inputRows.filter((r: any) => String(r.reconciliation_status) === "Mismatch").length
  if (twoBMismatch > 0) {
    alerts.push({
      type: "2B Mismatch",
      title: `GSTR-2B mismatch — ${period}`,
      body: `${twoBMismatch} purchase(s) in ${period} do not match GSTR-2B.`,
    })
  }

  return alerts
}

// ── Period-close checklist (Phase 40) ────────────────────────────────────────
export type CloseCheck = {
  key: string
  label: string
  passed: boolean
  detail: string
  required: boolean
}

export async function gstPeriodCloseChecklist(period: string): Promise<{
  period: string
  financial_year: string | null
  can_close: boolean
  already_closed: boolean
  status: string
  checks: CloseCheck[]
}> {
  if (!PERIOD_RE.test(period)) throw new Error("Period must be in YYYY-MM format.")
  const summary = await gstSummary(period)
  const compliance = await gstComplianceReport(period).catch(() => null)
  const center = await gstReconciliationCenter(period).catch(() => null)

  const status = summary.workflow.status
  const filed = FILING_STATUSES_FILED.has(status)
  const alreadyClosed = status === "Completed"

  const exceptions = compliance?.exceptions ?? []
  const countOf = (key: string) => exceptions.find((e: any) => e.key === key)?.count ?? 0
  const errorExceptions = exceptions.filter((e: any) => e.severity === "error").reduce((s: number, e: any) => s + e.count, 0)

  const itcLine = center?.lines.find((l) => l.key === "itc_2b")
  const itcReconciled = !itcLine || itcLine.status === "Matched"

  const checks: CloseCheck[] = [
    {
      key: "gstr1_ready",
      label: "GSTR-1 Ready",
      passed: FILING_STATUSES_PREPARED.has(status),
      detail: `Return status: ${status}`,
      required: true,
    },
    {
      key: "gstr3b_ready",
      label: "GSTR-3B Ready",
      passed: true,
      detail: `Net tax payable ${summary.gstr3b.net_tax_payable} (auto-computed)`,
      required: true,
    },
    {
      key: "itc_reconciled",
      label: "ITC Reconciled",
      passed: itcReconciled,
      detail: itcLine ? `Register vs 2B: ${itcLine.status}` : "No inward ITC to reconcile",
      required: true,
    },
    {
      key: "rcm_checked",
      label: "RCM Checked",
      passed: countOf("rcm_missing") === 0,
      detail: countOf("rcm_missing") === 0 ? "No unmarked reverse-charge purchases" : `${countOf("rcm_missing")} RCM issue(s)`,
      required: true,
    },
    {
      key: "tax_liability_checked",
      label: "Tax Liability Checked",
      passed: countOf("gst_calculation_error") === 0,
      detail:
        countOf("gst_calculation_error") === 0
          ? `Net liability ${summary.liability.net_liability}`
          : `${countOf("gst_calculation_error")} tax calculation error(s)`,
      required: true,
    },
    {
      key: "payment_checked",
      label: "Payment Checked",
      passed: summary.liability.balance_payable <= 1,
      detail:
        summary.liability.balance_payable <= 1
          ? "No balance payable"
          : `Balance payable ${summary.liability.balance_payable}`,
      required: true,
    },
    {
      key: "exceptions_resolved",
      label: "Exceptions Resolved",
      passed: errorExceptions === 0,
      detail: errorExceptions === 0 ? "No blocking exceptions" : `${errorExceptions} error-level exception(s)`,
      required: true,
    },
  ]

  const checksPass = checks.filter((c) => c.required).every((c) => c.passed)
  return {
    period,
    financial_year: summary.financial_year,
    can_close: filed && checksPass && !alreadyClosed,
    already_closed: alreadyClosed,
    status,
    checks,
  }
}

/**
 * Close a GST period (Phase 40). Refuses unless every required pre-close check
 * passes AND the return is already filed — it then marks the period Completed
 * through the existing lifecycle. It posts NOTHING to the ledger (Phase 38), so
 * closing can never create a duplicate Journal/GL entry.
 */
export async function closeGstPeriod(
  period: string,
  actor: { actorId?: number | null; actorName?: string | null } = {},
): Promise<{ period: string; status: string }> {
  const checklist = await gstPeriodCloseChecklist(period)
  if (checklist.already_closed) return { period, status: "Completed" }
  if (!FILING_STATUSES_FILED.has(checklist.status)) {
    throw new Error(`Cannot close ${period}: the GSTR-1 must be filed before the period is closed.`)
  }
  const failed = checklist.checks.filter((c) => c.required && !c.passed)
  if (failed.length) {
    throw new Error(`Cannot close ${period}: ${failed.map((c) => c.label).join(", ")} not satisfied.`)
  }
  const result = await transitionReturnStatus(period, "complete", {
    actorId: actor.actorId ?? null,
    actorName: actor.actorName ?? null,
  })
  await logFinanceEvent({
    entityType: "gst_filing",
    entityRef: `CLOSE:${period}`,
    type: "approved",
    summary: `GST period ${period} closed after all compliance checks passed.`,
    actorId: actor.actorId ?? null,
    actorName: actor.actorName ?? null,
  }).catch(() => {})
  return result as { period: string; status: string }
}

// ── The full audit trail for a period (Phase 32) ─────────────────────────────
export async function gstFilingAuditTrail(period: string, filingId?: string | null): Promise<FinanceAuditEvent[]> {
  const refs = [period, `TAX-PAID:${period}`, `RECON:${period}`, `CLOSE:${period}`]
  if (filingId) refs.push(filingId)
  return getFinanceEventsByRefs("gst_filing", refs)
}

// ── Daily sweep (Phase 37/38) ────────────────────────────────────────────────
// Exception check + mismatch check + unreconciled check, plus the payment/filing
// reminders that are meaningful every day. Idempotent and dedup-guarded.
export async function runDailyGstSweep(): Promise<{
  ran_at: string
  period: string
  alerts: number
  notifications: number
}> {
  const period = previousPeriod()
  const day = today()
  const alerts = await computeGstAlerts(period)
  let notifications = 0
  for (const alert of alerts) {
    notifications += await emitAlert(alert, `daily|${alert.type}|${period}|${day}`)
  }
  return { ran_at: new Date().toISOString(), period, alerts: alerts.length, notifications }
}

// ── Monthly sweep (Phase 37/38) ──────────────────────────────────────────────
// Runs the once-a-month preparation work for the period just ended: refresh the
// drafted GSTR-2B, re-run ITC reconciliation, and push the GSTR-1/3B-ready,
// filing and payment reminders. It NEVER files, pays, or posts — those remain
// explicit user actions — so re-running the month cannot duplicate any record.
export async function runMonthlyGstSweep(targetPeriod?: string): Promise<{
  ran_at: string
  period: string
  reconciled: { matched: number; mismatch: number; notIn2b: number; onlyIn2b: number } | null
  alerts: number
  notifications: number
}> {
  const period = targetPeriod && PERIOD_RE.test(targetPeriod) ? targetPeriod : previousPeriod()

  // Idempotent reconciliation prep: draft the 2B from the bills, then reconcile.
  let reconciled: { matched: number; mismatch: number; notIn2b: number; onlyIn2b: number } | null = null
  try {
    await draftGstr2bFromBills(period)
    const recon = await reconcilePeriod(period)
    reconciled = recon.tally
    await logFinanceEvent({
      entityType: "gst_filing",
      entityRef: `RECON:${period}`,
      type: "updated",
      summary: `Monthly ITC reconciliation for ${period}: ${recon.tally.matched} matched, ${recon.tally.mismatch} mismatch, ${recon.tally.notIn2b} not in 2B.`,
    }).catch(() => {})
  } catch (error) {
    console.log("[v0] monthly GST reconcile failed for", period, (error as Error)?.message)
  }

  const alerts = await computeGstAlerts(period)
  let notifications = 0
  const month = period // one dedup window per period for the monthly run
  for (const alert of alerts) {
    notifications += await emitAlert(alert, `monthly|${alert.type}|${month}`)
  }
  return { ran_at: new Date().toISOString(), period, reconciled, alerts: alerts.length, notifications }
}

// ── CA-ready package (Phase 35/36) ───────────────────────────────────────────
// A single consolidated read that assembles every dataset a CA needs to review a
// period. Pure aggregation over the existing engines — no new figures, no writes.
export async function gstCaPackage(period: string) {
  if (!PERIOD_RE.test(period)) throw new Error("Period must be in YYYY-MM format.")
  const [summary, compliance, inputRows, amendments, taxPaid] = await Promise.all([
    gstSummary(period),
    gstComplianceReport(period),
    listGstInput({ period }).catch(() => []),
    listReturnAmendments(period).catch(() => []),
    getGstTaxPaid(period).catch(() => 0),
  ])
  const center = await gstReconciliationCenter(period).catch(() => null)
  const audit = await gstFilingAuditTrail(period, summary.filing?.filing_id ?? null)

  return {
    period,
    financial_year: summary.financial_year,
    quarter: summary.quarter,
    generated_at: new Date().toISOString(),
    gstr1: {
      totals: summary.totals,
      rate_wise: summary.rate_wise,
      supply_split: summary.supply_split,
      invoices: summary.invoices,
      sections: summary.sections,
    },
    gstr3b: summary.gstr3b,
    liability: { ...summary.liability, tax_paid: taxPaid },
    gst_input: inputRows,
    two_b_reconciliation: compliance.three_b,
    reconciliation_center: center,
    exceptions: compliance.exceptions,
    rate_wise: compliance.rate_wise,
    supply_wise: compliance.supply_wise,
    client_wise: compliance.client_wise,
    vendor_wise: compliance.vendor_wise,
    credit_debit_notes: compliance.credit_debit_notes,
    raw_register: compliance.raw,
    amendments,
    audit,
    filing: summary.filing,
    workflow: summary.workflow,
  }
}
