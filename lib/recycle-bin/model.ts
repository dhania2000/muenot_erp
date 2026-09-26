/**
 * SPEC 35 — Soft delete & recycle bin (pure, testable model).
 * ---------------------------------------------------------------------------
 * The DB-free core for consistent soft deletion, a tenant-scoped recycle bin
 * with a bounded restore window, legal-hold protection, and hard-delete expiry.
 *
 * This module owns the deterministic decisions the store + routes rely on:
 *   - restore-window arithmetic (deadline, expiry),
 *   - the RESTORE-eligibility gate (wrong-tenant, expired, already restored,
 *     legal hold),
 *   - the HARD-DELETE (purge) eligibility gate,
 *   - input normalization for the delete reason and list filters.
 *
 * It carries no `server-only`, Node or DB import so the logic can be unit-tested
 * in isolation and shared with the settings UI — mirroring
 * lib/audit-retention-policy.ts and lib/legal-hold-model.ts.
 */

const DAY_MS = 86_400_000

export const RECYCLE_BIN_LIMITS = {
  /** No tenant may keep soft-deleted rows recoverable for fewer than 1 day... */
  MIN_RESTORE_DAYS: 1,
  /** ...nor longer than ~10 years (guards a fat-fingered value). */
  MAX_RESTORE_DAYS: 3650,
  REASON: 1000,
  ENTITY_TYPE: 120,
  ENTITY_TABLE: 120,
  ENTITY_PK: 190,
  ENTITY_LABEL: 255,
} as const

/** Platform default restore window: 30 days, the common recycle-bin default. */
export const DEFAULT_RESTORE_WINDOW_DAYS = 30

export const RECYCLE_ENTRY_STATUSES = ["recycled", "restored", "purged"] as const
export type RecycleEntryStatus = (typeof RECYCLE_ENTRY_STATUSES)[number]

export function isRecycleEntryStatus(value: unknown): value is RecycleEntryStatus {
  return typeof value === "string" && (RECYCLE_ENTRY_STATUSES as readonly string[]).includes(value)
}

/** Clamp an arbitrary restore-window day count into the allowed whole range. */
export function clampRestoreWindowDays(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_RESTORE_WINDOW_DAYS
  return Math.min(RECYCLE_BIN_LIMITS.MAX_RESTORE_DAYS, Math.max(RECYCLE_BIN_LIMITS.MIN_RESTORE_DAYS, n))
}

function trimTo(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max)
}

/** Coerce a caller-supplied delete reason into a stored value (or null). */
export function normalizeDeleteReason(value: unknown): string | null {
  const r = trimTo(value, RECYCLE_BIN_LIMITS.REASON)
  return r || null
}

// ---------------------------------------------------------------------------
// Restore-window arithmetic
// ---------------------------------------------------------------------------

/** The moment a soft-deleted record stops being restorable and becomes purgeable. */
export function computeRestoreDeadline(
  deletedAt: string | Date,
  windowDays: number = DEFAULT_RESTORE_WINDOW_DAYS,
): Date {
  const base = deletedAt instanceof Date ? deletedAt : new Date(deletedAt)
  const days = clampRestoreWindowDays(windowDays)
  return new Date(base.getTime() + days * DAY_MS)
}

/** True when `now` is at or past the restore deadline — the window has closed. */
export function isRestoreWindowExpired(deadline: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!deadline) return false
  const d = deadline instanceof Date ? deadline : new Date(deadline)
  if (Number.isNaN(d.getTime())) return false
  return now.getTime() >= d.getTime()
}

/** Whole days left in the restore window (0 once expired). For UI badges. */
export function restoreDaysRemaining(deadline: string | Date | null | undefined, now: Date = new Date()): number {
  if (!deadline) return 0
  const d = deadline instanceof Date ? deadline : new Date(deadline)
  if (Number.isNaN(d.getTime())) return 0
  const ms = d.getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}

// ---------------------------------------------------------------------------
// The recycle-bin entry shape the pure gates evaluate
// ---------------------------------------------------------------------------

export type RecycleEntryState = {
  tenantId: number
  status: RecycleEntryStatus
  restoreDeadline: string | Date | null
  /** A snapshot of legal-hold coverage captured at delete time (advisory). */
  legalHold: boolean
}

/** The verified request context a restore/purge is evaluated against. */
export type RestoreContext = {
  /** The session tenant — restores are only ever allowed within it. */
  tenantId: number
  /** Live legal-hold coverage re-checked at restore/purge time (authoritative). */
  legalHoldActive?: boolean
  /** Allow an admin to restore past the window (explicit override). */
  overrideWindow?: boolean
  now?: Date
}

export type RestoreDecision =
  | { ok: true }
  | { ok: false; code: RestoreDenyCode; message: string; status: number }

export type RestoreDenyCode =
  | "WRONG_TENANT"
  | "NOT_RECYCLED"
  | "WINDOW_EXPIRED"
  | "LEGAL_HOLD"

/**
 * The single authoritative gate for restoring a soft-deleted record. Ordered so
 * the most security-critical failure (cross-tenant access) wins first, then
 * state, then the recoverability window, then legal hold.
 *
 * Cross-tenant is fail-closed: an entry whose `tenantId` differs from the
 * request context is reported as WRONG_TENANT (404-style) — never restored.
 */
export function evaluateRestore(entry: RecycleEntryState, ctx: RestoreContext): RestoreDecision {
  const now = ctx.now ?? new Date()

  if (Number(entry.tenantId) !== Number(ctx.tenantId)) {
    return { ok: false, code: "WRONG_TENANT", message: "Recycle bin entry not found", status: 404 }
  }
  if (entry.status !== "recycled") {
    return {
      ok: false,
      code: "NOT_RECYCLED",
      message: `This entry is already ${entry.status} and cannot be restored`,
      status: 409,
    }
  }
  // A live legal hold ALWAYS wins — a held record can never be restored (nor
  // purged) until the hold is released, mirroring the retention subsystem.
  if (ctx.legalHoldActive ?? entry.legalHold) {
    return {
      ok: false,
      code: "LEGAL_HOLD",
      message: "This record is under a legal hold and cannot be restored",
      status: 423,
    }
  }
  if (!ctx.overrideWindow && isRestoreWindowExpired(entry.restoreDeadline, now)) {
    return {
      ok: false,
      code: "WINDOW_EXPIRED",
      message: "The restore window for this record has closed",
      status: 410,
    }
  }
  return { ok: true }
}

export type PurgeDecision =
  | { ok: true }
  | { ok: false; code: PurgeDenyCode; message: string; status: number }

export type PurgeDenyCode = "WRONG_TENANT" | "NOT_RECYCLED" | "LEGAL_HOLD" | "WINDOW_OPEN"

/**
 * The gate for HARD-DELETING (permanently purging) a soft-deleted record.
 *
 * `mode: "expiry"` is what the automated sweep uses — it only purges entries
 * whose restore window has CLOSED and that are not under a legal hold. `mode:
 * "manual"` lets a tenant admin purge early (still legal-hold protected).
 */
export function evaluatePurge(
  entry: RecycleEntryState,
  ctx: { tenantId: number; legalHoldActive?: boolean; mode: "expiry" | "manual"; now?: Date },
): PurgeDecision {
  const now = ctx.now ?? new Date()

  if (Number(entry.tenantId) !== Number(ctx.tenantId)) {
    return { ok: false, code: "WRONG_TENANT", message: "Recycle bin entry not found", status: 404 }
  }
  if (entry.status !== "recycled") {
    return { ok: false, code: "NOT_RECYCLED", message: `This entry is already ${entry.status}`, status: 409 }
  }
  if (ctx.legalHoldActive ?? entry.legalHold) {
    return { ok: false, code: "LEGAL_HOLD", message: "This record is under a legal hold and cannot be purged", status: 423 }
  }
  if (ctx.mode === "expiry" && !isRestoreWindowExpired(entry.restoreDeadline, now)) {
    return { ok: false, code: "WINDOW_OPEN", message: "The restore window is still open", status: 409 }
  }
  return { ok: true }
}

/** True when the automated sweep should purge this entry now. */
export function isPurgeableByExpiry(
  entry: RecycleEntryState,
  ctx: { tenantId: number; legalHoldActive?: boolean; now?: Date },
): boolean {
  return evaluatePurge(entry, { ...ctx, mode: "expiry" }).ok
}
