import { describe, expect, it } from "vitest"
import {
  AUDIT_RETENTION_LIMITS,
  DEFAULT_AUDIT_PLATFORM_POLICY,
  clampRetentionDays,
  computeRetentionCutoff,
  describeRetention,
  holdMatchesEntry,
  isBeyondRetention,
  isEntryUnderHold,
  normalizeAuditPlatformPolicy,
  normalizeAuditTenantPolicy,
  resolveEffectiveAuditPolicy,
  type AuditPlatformPolicy,
  type HoldableEntry,
} from "@/lib/audit-retention-policy"

/**
 * SPEC 68 — Phase 4. Pure, DB-free validation of the audit retention model:
 * day-count clamping, the platform compliance FLOOR that a tenant may never
 * drop below, the tenant → platform resolution precedence, retention cutoff
 * arithmetic, and the legal-hold matching predicate (including the guarantee
 * that an empty hold freezes EVERYTHING in scope). Fixed clocks keep every
 * time-based assertion deterministic.
 */

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

describe("clampRetentionDays", () => {
  it("clamps into the allowed whole-number range", () => {
    expect(clampRetentionDays(0)).toBe(AUDIT_RETENTION_LIMITS.MIN_DAYS)
    expect(clampRetentionDays(-100)).toBe(AUDIT_RETENTION_LIMITS.MIN_DAYS)
    expect(clampRetentionDays(1_000_000)).toBe(AUDIT_RETENTION_LIMITS.MAX_DAYS)
    expect(clampRetentionDays(90.9)).toBe(90)
    expect(clampRetentionDays("365" as unknown)).toBe(365)
    expect(clampRetentionDays("garbage" as unknown)).toBe(AUDIT_RETENTION_LIMITS.MIN_DAYS)
  })

  it("respects a raised floor argument", () => {
    // With a 365-day floor, anything lower is lifted to 365.
    expect(clampRetentionDays(30, 365)).toBe(365)
    expect(clampRetentionDays(400, 365)).toBe(400)
    // A floor below the hard minimum can never drop below MIN_DAYS.
    expect(clampRetentionDays(1, 5)).toBe(AUDIT_RETENTION_LIMITS.MIN_DAYS)
  })
})

// ---------------------------------------------------------------------------
// Platform policy normalization
// ---------------------------------------------------------------------------

describe("normalizeAuditPlatformPolicy", () => {
  it("falls back to conservative defaults for garbage input", () => {
    for (const bad of [null, undefined, "nope" as unknown, {}]) {
      expect(normalizeAuditPlatformPolicy(bad)).toEqual(DEFAULT_AUDIT_PLATFORM_POLICY)
    }
  })

  it("never lets the default retention drop below the min floor", () => {
    const p = normalizeAuditPlatformPolicy({
      minRetentionDays: 400,
      defaultRetentionDays: 100,
      archiveEnabled: true,
      purgeAfterArchive: false,
    })
    expect(p.minRetentionDays).toBe(400)
    // default is clamped UP to the floor, not left below it.
    expect(p.defaultRetentionDays).toBe(400)
  })

  it("coerces loose boolean-ish toggle values", () => {
    const p = normalizeAuditPlatformPolicy({
      minRetentionDays: 365,
      defaultRetentionDays: 730,
      archiveEnabled: "yes" as unknown as boolean,
      purgeAfterArchive: 0 as unknown as boolean,
    })
    expect(p.archiveEnabled).toBe(true)
    expect(p.purgeAfterArchive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tenant policy — the compliance floor is absolute
// ---------------------------------------------------------------------------

describe("normalizeAuditTenantPolicy — floor is absolute", () => {
  const platform: AuditPlatformPolicy = {
    minRetentionDays: 365,
    defaultRetentionDays: 2555,
    archiveEnabled: true,
    purgeAfterArchive: false,
  }

  it("raises a too-short tenant window to the platform floor", () => {
    const t = normalizeAuditTenantPolicy({ retentionDays: 30, enabled: true }, platform)
    expect(t.retentionDays).toBe(365)
  })

  it("allows a tenant to retain LONGER than the platform default", () => {
    const t = normalizeAuditTenantPolicy({ retentionDays: 3650, enabled: true }, platform)
    expect(t.retentionDays).toBe(3650)
  })

  it("inherits platform archive/purge defaults when unset", () => {
    const t = normalizeAuditTenantPolicy({ retentionDays: 730 }, platform)
    expect(t.archiveEnabled).toBe(true)
    expect(t.purgeAfterArchive).toBe(false)
    expect(t.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Resolution precedence
// ---------------------------------------------------------------------------

describe("resolveEffectiveAuditPolicy — tenant overrides platform", () => {
  const platform: AuditPlatformPolicy = {
    minRetentionDays: 365,
    defaultRetentionDays: 2555,
    archiveEnabled: true,
    purgeAfterArchive: false,
  }

  it("uses the platform default when the tenant has no override", () => {
    const r = resolveEffectiveAuditPolicy(null, platform)
    expect(r.source).toBe("platform")
    expect(r.retentionDays).toBe(2555)
    expect(r.enabled).toBe(true)
  })

  it("uses the tenant override, still clamped to the floor", () => {
    const r = resolveEffectiveAuditPolicy({ retentionDays: 30, purgeAfterArchive: true, enabled: true }, platform)
    expect(r.source).toBe("tenant")
    expect(r.retentionDays).toBe(365)
    expect(r.purgeAfterArchive).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cutoff arithmetic
// ---------------------------------------------------------------------------

describe("computeRetentionCutoff / isBeyondRetention", () => {
  const now = new Date("2026-06-01T00:00:00Z")

  it("computes a cutoff exactly N days before now", () => {
    const cutoff = computeRetentionCutoff(30, now)
    expect(cutoff.toISOString()).toBe("2026-05-02T00:00:00.000Z")
  })

  it("treats entries on or before the cutoff as beyond retention", () => {
    expect(isBeyondRetention("2026-05-01T00:00:00Z", 30, now)).toBe(true)
    // Exactly at the cutoff boundary is inclusive.
    expect(isBeyondRetention("2026-05-02T00:00:00Z", 30, now)).toBe(true)
    expect(isBeyondRetention("2026-05-15T00:00:00Z", 30, now)).toBe(false)
  })

  it("ignores missing/invalid timestamps", () => {
    expect(isBeyondRetention(null, 30, now)).toBe(false)
    expect(isBeyondRetention("not-a-date", 30, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Legal holds — the freeze predicate
// ---------------------------------------------------------------------------

describe("holdMatchesEntry / isEntryUnderHold", () => {
  const entry: HoldableEntry = {
    action: "user.update",
    entityType: "user",
    actorUserId: 42,
    createdAt: "2026-03-15T12:00:00Z",
  }

  it("an empty hold freezes EVERYTHING in scope", () => {
    expect(holdMatchesEntry({}, entry)).toBe(true)
  })

  it("matches on a single filter and combines multiple with AND", () => {
    expect(holdMatchesEntry({ action: "user.update" }, entry)).toBe(true)
    expect(holdMatchesEntry({ action: "user.delete" }, entry)).toBe(false)
    expect(holdMatchesEntry({ action: "user.update", entityType: "user" }, entry)).toBe(true)
    expect(holdMatchesEntry({ action: "user.update", entityType: "invoice" }, entry)).toBe(false)
  })

  it("matches on actor id", () => {
    expect(holdMatchesEntry({ actorUserId: 42 }, entry)).toBe(true)
    expect(holdMatchesEntry({ actorUserId: 7 }, entry)).toBe(false)
  })

  it("respects the from/to date window", () => {
    expect(holdMatchesEntry({ fromDate: "2026-03-01T00:00:00Z" }, entry)).toBe(true)
    expect(holdMatchesEntry({ fromDate: "2026-04-01T00:00:00Z" }, entry)).toBe(false)
    expect(holdMatchesEntry({ toDate: "2026-04-01T00:00:00Z" }, entry)).toBe(true)
    expect(holdMatchesEntry({ toDate: "2026-03-01T00:00:00Z" }, entry)).toBe(false)
  })

  it("isEntryUnderHold is true when ANY hold covers the entry", () => {
    const holds = [{ action: "user.delete" }, { entityType: "user" }]
    expect(isEntryUnderHold(holds, entry)).toBe(true)
    expect(isEntryUnderHold([{ action: "role.assign" }], entry)).toBe(false)
    // No holds at all → nothing frozen.
    expect(isEntryUnderHold([], entry)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Human-readable description
// ---------------------------------------------------------------------------

describe("describeRetention", () => {
  it("describes whole years, months, and raw days", () => {
    expect(describeRetention(365)).toBe("1 year")
    expect(describeRetention(730)).toBe("2 years")
    expect(describeRetention(90)).toBe("3 months")
    expect(describeRetention(30)).toBe("1 month")
    expect(describeRetention(45)).toBe("45 days")
  })
})
