import "server-only"

/**
 * Document Expiry service (SPEC 88, Phase 2 + 3).
 *
 * The single reusable entry point for everything expiry-related:
 *   • `getExpiryOverview()`  — classified items + KPIs for the dashboard/API.
 *   • `runExpirySweep()`     — the cron sweep that escalates and notifies.
 *
 * It builds on the existing, battle-tested reminder plumbing in
 * `finance-automation-shared` (recipients + dedup + in-app bell) rather than
 * inventing a parallel notification surface, and on the pure date engine in
 * `lib/expiry/date.ts` so classification is timezone-stable and unit-testable.
 */
import { EXPIRY_SOURCES, fetchAllExpiryRows, type ExpirySource } from "@/lib/expiry/sources"
import type { ExpiryCategory, ExpiryItem, ExpirySourceRow } from "@/lib/expiry/model"
import {
  evaluateExpiry,
  type EscalationTier,
  type ExpiryStatus,
} from "@/lib/expiry/date"
import { emitReminder, financeRecipients } from "@/lib/finance-automation-shared"

/** Business timezone used to decide what "today" is when classifying dates. */
export const EXPIRY_TIME_ZONE = process.env.EXPIRY_TIME_ZONE || "Asia/Kolkata"

/** Feature that gates who receives escalation notifications for expiries. */
const NOTIFY_FEATURE = "hr.view_documents"

function classifyRow(row: ExpirySourceRow, now: Date): ExpiryItem | null {
  if (!row.expiryDate) return null
  const evaluated = evaluateExpiry(row.expiryDate, {
    now,
    timeZone: EXPIRY_TIME_ZONE,
    warnDays: row.warnDays,
  })
  return {
    ...row,
    expiryDate: evaluated.expiryDate!,
    daysUntil: evaluated.daysUntil!,
    status: evaluated.status,
    escalation: evaluated.escalation,
    renewalStatus: evaluated.renewalStatus,
    milestone: evaluated.milestone,
  }
}

/** All expiry-bearing records, classified and sorted soonest-expiring first. */
export async function getClassifiedExpiries(now: Date = new Date()): Promise<ExpiryItem[]> {
  const rows = await fetchAllExpiryRows()
  const items = rows.map((r) => classifyRow(r, now)).filter((i): i is ExpiryItem => i !== null)
  items.sort((a, b) => a.daysUntil - b.daysUntil)
  return items
}

export type ExpiryOverview = {
  timeZone: string
  generatedAt: string
  items: ExpiryItem[]
  kpis: {
    total: number
    valid: number
    expiringSoon: number
    expired: number
    escalated: number
  }
  byCategory: { category: ExpiryCategory; total: number; expiringSoon: number; expired: number }[]
  byStatus: { status: ExpiryStatus; count: number }[]
}

/** Dashboard/API payload: classified items plus aggregate KPIs. */
export async function getExpiryOverview(now: Date = new Date()): Promise<ExpiryOverview> {
  const items = await getClassifiedExpiries(now)

  const kpis = { total: items.length, valid: 0, expiringSoon: 0, expired: 0, escalated: 0 }
  const catMap = new Map<ExpiryCategory, { total: number; expiringSoon: number; expired: number }>()

  for (const it of items) {
    if (it.status === "Valid") kpis.valid++
    else if (it.status === "Expiring Soon") kpis.expiringSoon++
    else if (it.status === "Expired") kpis.expired++
    if (it.escalation === "urgent" || it.escalation === "overdue") kpis.escalated++

    const c = catMap.get(it.category) ?? { total: 0, expiringSoon: 0, expired: 0 }
    c.total++
    if (it.status === "Expiring Soon") c.expiringSoon++
    if (it.status === "Expired") c.expired++
    catMap.set(it.category, c)
  }

  const byCategory = Array.from(catMap.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.expired - a.expired || b.expiringSoon - a.expiringSoon || b.total - a.total)

  const byStatus: { status: ExpiryStatus; count: number }[] = [
    { status: "Expired", count: kpis.expired },
    { status: "Expiring Soon", count: kpis.expiringSoon },
    { status: "Valid", count: kpis.valid },
  ]

  return {
    timeZone: EXPIRY_TIME_ZONE,
    generatedAt: now.toISOString(),
    items,
    kpis,
    byCategory,
    byStatus,
  }
}

/**
 * Escalation recipients. Everyone who can see documents gets warnings; urgent
 * and overdue items additionally reach the document owner (the employee) so the
 * escalation actually lands on the person who can act on it.
 */
async function recipientsFor(item: ExpiryItem, base: number[]): Promise<number[]> {
  const set = new Set<number>(base)
  if ((item.escalation === "urgent" || item.escalation === "overdue") && item.ownerUserId) {
    set.add(item.ownerUserId)
  }
  return Array.from(set)
}

const ESCALATION_LABEL: Record<EscalationTier, string> = {
  none: "",
  notice: "Reminder",
  warning: "Warning",
  urgent: "Urgent",
  overdue: "Overdue",
}

function reminderBody(item: ExpiryItem): string {
  const ref = item.documentNumber ? ` (${item.documentNumber})` : ""
  if (item.daysUntil < 0) {
    const ago = Math.abs(item.daysUntil)
    return `${item.title}${ref} expired ${ago} day${ago === 1 ? "" : "s"} ago (${item.expiryDate}). Renewal is overdue.`
  }
  if (item.daysUntil === 0) return `${item.title}${ref} expires today (${item.expiryDate}).`
  return `${item.title}${ref} expires in ${item.daysUntil} day${item.daysUntil === 1 ? "" : "s"} (${item.expiryDate}).`
}

export type SweepResult = {
  scanned: number
  actionable: number
  notificationsSent: number
  byTier: Record<EscalationTier, number>
  skippedSources: string[]
}

/**
 * The cron sweep. Classifies every notifying source, then for each item that
 * has crossed a reminder milestone fires a single deduped, escalation-tagged
 * notification. Idempotent within a milestone window via `emitReminder`'s dedup
 * table, so repeated runs on the same day never re-notify.
 */
export async function runExpirySweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    actionable: 0,
    notificationsSent: 0,
    byTier: { none: 0, notice: 0, warning: 0, urgent: 0, overdue: 0 },
    skippedSources: [],
  }

  // Sources that own their own notifications are dashboard-only.
  const sweepSources = new Set(
    EXPIRY_SOURCES.filter((s: ExpirySource) => !s.notifiesElsewhere).map((s) => s.id),
  )
  for (const s of EXPIRY_SOURCES) if (s.notifiesElsewhere) result.skippedSources.push(s.id)

  const items = await getClassifiedExpiries(now)
  result.scanned = items.length

  const baseRecipients = await financeRecipients(NOTIFY_FEATURE).catch(() => [] as number[])

  for (const item of items) {
    if (!sweepSources.has(item.sourceId)) continue
    // Only act inside the notification window (milestone !== null) and once the
    // item is at least at "notice" severity.
    if (!item.milestone || item.escalation === "none") continue

    result.actionable++
    result.byTier[item.escalation]++

    const recipients = await recipientsFor(item, baseRecipients)
    if (recipients.length === 0) continue

    const tier = ESCALATION_LABEL[item.escalation]
    const key = `docexp:${item.sourceId}:${item.entityId}:${item.expiryDate}:${item.milestone}`
    const sent = await emitReminder(
      {
        key,
        type: "document_expiry",
        title: `${tier}: ${item.category} expiry`,
        body: reminderBody(item),
        link: "/modules/operations/document-expiry",
        entityType: item.sourceId,
        entityId: item.entityId,
      },
      recipients,
    ).catch(() => 0)
    result.notificationsSent += sent
  }

  return result
}
