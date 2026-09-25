/**
 * Audit log retention (pure model).
 * ---------------------------------------------------------------------------
 * gave the platform a single immutable, append-only audit trail
 * (`audit_log_entries`, see lib/audit-log-store.ts). makes the LIFECYCLE
 * of that trail configurable while preserving its immutability:
 *
 *   - Platform policy — a platform-wide DEFAULT retention window plus a MINIMUM
 *     floor no tenant may drop below (a compliance guarantee the operator sets
 *     once). Also the platform default for whether archiving/purging is on.
 *   - Tenant policy   — a tenant may retain LONGER than the platform default and
 *     choose whether aged entries are archived and (optionally) purged from the
 *     hot table after they have been sealed into the immutable archive. A tenant
 *     may never retain SHORTER than the platform floor.
 *   - Legal hold      — freezes matching entries so they are never purged, even
 *     once their retention window has elapsed, until the hold is released.
 *
 * This module is the pure, DB-free core: clamping, precedence, cutoff math and
 * the legal-hold matching predicate. Kept free of `server-only`, Node and the
 * DB so the arithmetic can be unit-tested in isolation and shared with the
 * settings UI (mirrors lib/storage/retention-policy.ts).
 */

export const AUDIT_RETENTION_LIMITS = {
  /** No policy may keep audit entries for fewer than 30 days. */
  MIN_DAYS: 30,
  /** Cap at ~15 years so a fat-fingered value can't create a nonsensical rule. */
  MAX_DAYS: 5475,
} as const

const DAY_MS = 86_400_000

export type AuditPlatformPolicy = {
  /** Default retention window (days) applied to any tenant without an override. */
  defaultRetentionDays: number
  /** Compliance floor: no tenant may retain for fewer days than this. */
  minRetentionDays: number
  /** Whether archiving of aged entries is enabled by default. */
  archiveEnabled: boolean
  /** Whether archived entries are purged from the hot table by default. */
  purgeAfterArchive: boolean
}

export type AuditTenantPolicy = {
  /** This tenant's chosen retention window (days). Clamped to the platform floor. */
  retentionDays: number
  archiveEnabled: boolean
  purgeAfterArchive: boolean
  /** Master switch — when false the retention job skips this tenant entirely. */
  enabled: boolean
}

/**
 * Seven-year default (the common statutory floor for financial/audit records),
 * with a one-year hard floor and archiving on but purging off — the safe,
 * conservative starting point for a fresh install.
 */
export const DEFAULT_AUDIT_PLATFORM_POLICY: AuditPlatformPolicy = {
  defaultRetentionDays: 2555,
  minRetentionDays: 365,
  archiveEnabled: true,
  purgeAfterArchive: false,
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  const s = String(value).trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(s)) return true
  if (["0", "false", "no", "off"].includes(s)) return false
  return fallback
}

/** Clamp an arbitrary day count into the allowed whole-number range. */
export function clampRetentionDays(value: unknown, min: number = AUDIT_RETENTION_LIMITS.MIN_DAYS): number {
  const n = Math.floor(Number(value))
  const lower = Math.max(AUDIT_RETENTION_LIMITS.MIN_DAYS, Math.floor(min))
  if (!Number.isFinite(n)) return lower
  return Math.min(AUDIT_RETENTION_LIMITS.MAX_DAYS, Math.max(lower, n))
}

/** Coerce arbitrary input into a valid platform policy. */
export function normalizeAuditPlatformPolicy(input: unknown): AuditPlatformPolicy {
  const obj = (input ?? {}) as Partial<AuditPlatformPolicy>
  const minRetentionDays = clampRetentionDays(
    obj.minRetentionDays ?? DEFAULT_AUDIT_PLATFORM_POLICY.minRetentionDays,
    AUDIT_RETENTION_LIMITS.MIN_DAYS,
  )
  const defaultRetentionDays = clampRetentionDays(
    obj.defaultRetentionDays ?? DEFAULT_AUDIT_PLATFORM_POLICY.defaultRetentionDays,
    minRetentionDays,
  )
  return {
    minRetentionDays,
    defaultRetentionDays,
    archiveEnabled: toBool(obj.archiveEnabled, DEFAULT_AUDIT_PLATFORM_POLICY.archiveEnabled),
    purgeAfterArchive: toBool(obj.purgeAfterArchive, DEFAULT_AUDIT_PLATFORM_POLICY.purgeAfterArchive),
  }
}

/**
 * Coerce arbitrary input into a valid tenant policy, clamped so it can never
 * drop below the platform's compliance floor.
 */
export function normalizeAuditTenantPolicy(input: unknown, platform: AuditPlatformPolicy): AuditTenantPolicy {
  const obj = (input ?? {}) as Partial<AuditTenantPolicy>
  const floor = normalizeAuditPlatformPolicy(platform).minRetentionDays
  const retentionDays = clampRetentionDays(obj.retentionDays ?? platform.defaultRetentionDays, floor)
  return {
    retentionDays,
    archiveEnabled: toBool(obj.archiveEnabled, platform.archiveEnabled),
    purgeAfterArchive: toBool(obj.purgeAfterArchive, platform.purgeAfterArchive),
    enabled: toBool(obj.enabled, true),
  }
}

/**
 * The effective policy for a tenant: its own override clamped to the platform
 * floor, or the platform default when the tenant has no override. Returns the
 * concrete numbers the retention job acts on.
 */
export function resolveEffectiveAuditPolicy(
  tenant: Partial<AuditTenantPolicy> | null | undefined,
  platform: AuditPlatformPolicy,
): AuditTenantPolicy & { source: "tenant" | "platform" } {
  const p = normalizeAuditPlatformPolicy(platform)
  if (!tenant) {
    return {
      retentionDays: p.defaultRetentionDays,
      archiveEnabled: p.archiveEnabled,
      purgeAfterArchive: p.purgeAfterArchive,
      enabled: true,
      source: "platform",
    }
  }
  return { ...normalizeAuditTenantPolicy(tenant, p), source: "tenant" }
}

/**
 * The cutoff timestamp: entries created on or before this are older than the
 * retention window and therefore eligible for archive/purge.
 */
export function computeRetentionCutoff(retentionDays: number, now: Date = new Date()): Date {
  const days = clampRetentionDays(retentionDays)
  return new Date(now.getTime() - days * DAY_MS)
}

/** True when `createdAt` is on or before the cutoff — past the retention window. */
export function isBeyondRetention(
  createdAt: string | Date | null | undefined,
  retentionDays: number,
  now: Date = new Date(),
): boolean {
  if (!createdAt) return false
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= computeRetentionCutoff(retentionDays, now).getTime()
}

// ---------------------------------------------------------------------------
// Legal holds
// ---------------------------------------------------------------------------

export type AuditLegalHoldStatus = "active" | "released"

/**
 * A legal hold freezes a slice of the audit trail. All filters are optional and
 * combined with AND; an empty hold (no filters) freezes EVERYTHING in scope —
 * the safe default for a broad litigation hold.
 */
export type AuditLegalHoldFilter = {
  action?: string | null
  entityType?: string | null
  actorUserId?: number | null
  fromDate?: string | null
  toDate?: string | null
}

/** Fields of an audit entry the hold predicate needs. */
export type HoldableEntry = {
  action: string
  entityType: string | null
  actorUserId: number | null
  createdAt: string | Date
}

/** Does `entry` fall within the scope of an (active) legal `hold`? Pure. */
export function holdMatchesEntry(hold: AuditLegalHoldFilter, entry: HoldableEntry): boolean {
  if (hold.action && hold.action !== entry.action) return false
  if (hold.entityType && hold.entityType !== entry.entityType) return false
  if (hold.actorUserId != null && Number(hold.actorUserId) !== Number(entry.actorUserId)) return false
  const ts = entry.createdAt instanceof Date ? entry.createdAt.getTime() : new Date(entry.createdAt).getTime()
  if (Number.isNaN(ts)) return false
  if (hold.fromDate) {
    const from = new Date(hold.fromDate).getTime()
    if (!Number.isNaN(from) && ts < from) return false
  }
  if (hold.toDate) {
    const to = new Date(hold.toDate).getTime()
    if (!Number.isNaN(to) && ts > to) return false
  }
  return true
}

/** True when ANY active hold covers the entry. */
export function isEntryUnderHold(holds: AuditLegalHoldFilter[], entry: HoldableEntry): boolean {
  return holds.some((h) => holdMatchesEntry(h, entry))
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Human-readable description of a retention window for settings/audit surfaces. */
export function describeRetention(days: number): string {
  const d = clampRetentionDays(days)
  if (d % 365 === 0) {
    const years = d / 365
    return `${years} ${years === 1 ? "year" : "years"}`
  }
  if (d % 30 === 0) {
    const months = d / 30
    return `${months} ${months === 1 ? "month" : "months"}`
  }
  return `${d} ${d === 1 ? "day" : "days"}`
}
