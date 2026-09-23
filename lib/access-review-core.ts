/**
 * SPEC 66 — Access reviews: the pure model.
 * ---------------------------------------------------------------------------
 * Framework-free logic shared by the DB store (lib/access-review-store.ts),
 * the scheduled cron (app/api/cron/access-reviews) and the UI. Keeping the
 * recurrence math, status derivation and overdue/escalation rules here (with
 * no DB or request dependency) mirrors the house pattern used by
 * lib/user-lifecycle-core.ts and lib/sod.ts, and lets these rules be reasoned
 * about and unit-tested in isolation.
 *
 * An access review campaign snapshots a set of "subjects" (users, roles,
 * permission grants, temporary access, API keys, service accounts) that a
 * manager/admin must individually certify. Each subject becomes a review
 * ITEM the reviewer resolves with one decision:
 *   - approve    → access is appropriate, certified as-is
 *   - revoke     → access is removed now (executed where a safe mechanism exists)
 *   - remediate  → access needs a follow-up change (flagged for action)
 * Every transition is appended to an immutable audit trail.
 */

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export type ReviewSubjectType =
  | "user"
  | "role"
  | "permission"
  | "temporary_access"
  | "api_key"
  | "service_account"

export const SUBJECT_TYPES: {
  key: ReviewSubjectType
  label: string
  /** Plural noun used in progress copy. */
  plural: string
  description: string
}[] = [
  { key: "user", label: "User", plural: "users", description: "Active and suspended user accounts and their assigned role." },
  { key: "role", label: "Role", plural: "roles", description: "Custom roles and the permission matrix each one carries." },
  {
    key: "permission",
    label: "Permission",
    plural: "permissions",
    description: "Users holding a personal permission override on top of their roles.",
  },
  {
    key: "temporary_access",
    label: "Temporary access",
    plural: "temporary grants",
    description: "Active and scheduled time-boxed elevation grants.",
  },
  { key: "api_key", label: "API key", plural: "API keys", description: "Active API keys and the scopes they can use." },
  {
    key: "service_account",
    label: "Service account",
    plural: "service accounts",
    description: "Long-lived, non-expiring machine credentials that never rotate on their own.",
  },
]

export function subjectMeta(type: ReviewSubjectType) {
  return SUBJECT_TYPES.find((s) => s.key === type) ?? SUBJECT_TYPES[0]
}

export function isReviewSubjectType(v: unknown): v is ReviewSubjectType {
  return typeof v === "string" && SUBJECT_TYPES.some((s) => s.key === v)
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type ReviewDecision = "pending" | "approved" | "revoked" | "remediated"

export const DECISIONS: { key: Exclude<ReviewDecision, "pending">; label: string; verb: string }[] = [
  { key: "approved", label: "Approved", verb: "approve" },
  { key: "revoked", label: "Revoked", verb: "revoke" },
  { key: "remediated", label: "Remediated", verb: "remediate" },
]

export function isDecision(v: unknown): v is Exclude<ReviewDecision, "pending"> {
  return v === "approved" || v === "revoked" || v === "remediated"
}

// ---------------------------------------------------------------------------
// Campaigns & recurrence
// ---------------------------------------------------------------------------

export type ReviewFrequency = "once" | "monthly" | "quarterly" | "semiannual" | "annual"

export const FREQUENCIES: { key: ReviewFrequency; label: string; days: number | null }[] = [
  { key: "once", label: "One-time", days: null },
  { key: "monthly", label: "Monthly", days: 30 },
  { key: "quarterly", label: "Quarterly", days: 91 },
  { key: "semiannual", label: "Every 6 months", days: 182 },
  { key: "annual", label: "Annual", days: 365 },
]

export function isFrequency(v: unknown): v is ReviewFrequency {
  return typeof v === "string" && FREQUENCIES.some((f) => f.key === v)
}

export function frequencyDays(frequency: ReviewFrequency): number | null {
  return FREQUENCIES.find((f) => f.key === frequency)?.days ?? null
}

/** The next occurrence for a recurring campaign, or null for one-time reviews. */
export function nextRunAt(frequency: ReviewFrequency, from: Date): Date | null {
  const days = frequencyDays(frequency)
  if (days == null) return null
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000)
}

/** Persisted campaign status. `overdue` is derived (see computeStatus). */
export type CampaignStatus = "active" | "completed" | "cancelled"

/** The status shown to a reviewer, which folds in the overdue derivation. */
export type DerivedCampaignStatus = CampaignStatus | "overdue"

// ---------------------------------------------------------------------------
// Overdue & escalation
// ---------------------------------------------------------------------------

/** Whole days `dueAt` is past `now` (negative when not yet due). */
export function daysOverdue(dueAt: string | Date | null, now: Date = new Date()): number {
  if (!dueAt) return 0
  const due = typeof dueAt === "string" ? new Date(dueAt) : dueAt
  if (Number.isNaN(due.getTime())) return 0
  return Math.floor((now.getTime() - due.getTime()) / (24 * 60 * 60 * 1000))
}

export function isOverdue(dueAt: string | Date | null, now: Date = new Date()): boolean {
  return daysOverdue(dueAt, now) > 0
}

/**
 * Escalation tiers for an open, overdue campaign. Each higher tier widens who
 * gets pinged and how loudly:
 *   0 — on track (not yet due, or completed)
 *   1 — overdue, reviewer reminded
 *   2 — 7+ days overdue, escalated to the tenant owner
 *   3 — 14+ days overdue, flagged as a security risk
 */
export type EscalationLevel = 0 | 1 | 2 | 3

export function escalationLevel(dueAt: string | Date | null, now: Date = new Date()): EscalationLevel {
  const d = daysOverdue(dueAt, now)
  if (d <= 0) return 0
  if (d >= 14) return 3
  if (d >= 7) return 2
  return 1
}

export const ESCALATION_LABELS: Record<EscalationLevel, string> = {
  0: "On track",
  1: "Overdue",
  2: "Escalated",
  3: "At risk",
}

// ---------------------------------------------------------------------------
// Status & progress derivation
// ---------------------------------------------------------------------------

export type ReviewItemLike = { decision: ReviewDecision }

export type ReviewProgress = {
  total: number
  pending: number
  approved: number
  revoked: number
  remediated: number
  reviewed: number
  /** 0–100, rounded. A campaign with no items reads as 100% (nothing to do). */
  percent: number
  complete: boolean
}

export function computeProgress(items: ReviewItemLike[]): ReviewProgress {
  const total = items.length
  let approved = 0
  let revoked = 0
  let remediated = 0
  for (const it of items) {
    if (it.decision === "approved") approved++
    else if (it.decision === "revoked") revoked++
    else if (it.decision === "remediated") remediated++
  }
  const reviewed = approved + revoked + remediated
  const pending = total - reviewed
  const percent = total === 0 ? 100 : Math.round((reviewed / total) * 100)
  return { total, pending, approved, revoked, remediated, reviewed, percent, complete: pending === 0 }
}

/**
 * Fold the stored status, item progress and due date into the status a
 * reviewer should see. A campaign auto-reads as `completed` once every item is
 * resolved, and as `overdue` when it is still open past its due date.
 */
export function computeStatus(
  stored: CampaignStatus,
  progress: ReviewProgress,
  dueAt: string | Date | null,
  now: Date = new Date(),
): DerivedCampaignStatus {
  if (stored === "cancelled") return "cancelled"
  if (stored === "completed" || progress.complete) return "completed"
  if (isOverdue(dueAt, now)) return "overdue"
  return "active"
}
