import { describe, expect, it } from "vitest"
import {
  BYTES_PER_GB,
  DEFAULT_QUOTA_SETTINGS,
  bytesToGb,
  computeQuotaStatus,
  decideUpload,
  formatBytes,
  gbToBytes,
  normalizeWarnThreshold,
  resolveEffectiveQuota,
  usagePercent,
  type QuotaSettings,
} from "@/lib/storage/storage-quota"

/**
 * Phase 4. Pure, DB-free validation of the storage-quota model:
 * quota resolution (plan vs custom vs unlimited), usage classification against
 * the warning threshold, and the upload gate across the scenarios the spec
 * cares about — WITHIN quota, WARNING (near the threshold), and OVER quota with
 * both HARD-LIMIT (blocking) and soft (report-only) enforcement.
 */

const settings = (over: Partial<QuotaSettings> = {}): QuotaSettings => ({
  ...DEFAULT_QUOTA_SETTINGS,
  ...over,
})

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

describe("byte / GB conversion", () => {
  it("round-trips whole gigabytes", () => {
    expect(gbToBytes(10)).toBe(10 * BYTES_PER_GB)
    expect(bytesToGb(gbToBytes(10))).toBe(10)
  })

  it("floors fractional bytes and never goes negative", () => {
    expect(gbToBytes(-5)).toBe(0)
    expect(gbToBytes(0)).toBe(0)
  })

  it("formats byte sizes compactly", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(BYTES_PER_GB)).toBe("1 GB")
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GB")
  })
})

describe("warning-threshold normalization", () => {
  it("clamps to 1–100 and rounds", () => {
    expect(normalizeWarnThreshold(80)).toBe(80)
    expect(normalizeWarnThreshold(0)).toBe(1)
    expect(normalizeWarnThreshold(250)).toBe(100)
    expect(normalizeWarnThreshold(79.6)).toBe(80)
  })

  it("falls back to the default on garbage", () => {
    expect(normalizeWarnThreshold("nonsense")).toBe(80)
    expect(normalizeWarnThreshold(null)).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// Phase 1 — quota resolution (plan ⊕ custom override)
// ---------------------------------------------------------------------------

describe("resolveEffectiveQuota", () => {
  it("uses the plan quota when there is no custom override", () => {
    const r = resolveEffectiveQuota(10, null)
    expect(r.source).toBe("plan")
    expect(r.quotaBytes).toBe(10 * BYTES_PER_GB)
  })

  it("treats a null plan quota as unlimited", () => {
    const r = resolveEffectiveQuota(null, null)
    expect(r.source).toBe("plan")
    expect(r.quotaBytes).toBeNull()
  })

  it("lets a custom override supersede the plan quota", () => {
    const r = resolveEffectiveQuota(10, 50 * BYTES_PER_GB)
    expect(r.source).toBe("custom")
    expect(r.quotaBytes).toBe(50 * BYTES_PER_GB)
  })

  it("honours a custom override even when the plan is unlimited", () => {
    const r = resolveEffectiveQuota(null, 5 * BYTES_PER_GB)
    expect(r.source).toBe("custom")
    expect(r.quotaBytes).toBe(5 * BYTES_PER_GB)
  })

  it("supports a custom override of zero (no storage)", () => {
    const r = resolveEffectiveQuota(10, 0)
    expect(r.source).toBe("custom")
    expect(r.quotaBytes).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — usage classification
// ---------------------------------------------------------------------------

describe("usagePercent", () => {
  it("computes the percent of a finite quota", () => {
    expect(usagePercent(gbToBytes(8), gbToBytes(10))).toBeCloseTo(80)
  })
  it("returns null for unlimited / zero quotas", () => {
    expect(usagePercent(100, null)).toBeNull()
    expect(usagePercent(100, 0)).toBeNull()
  })
})

describe("computeQuotaStatus", () => {
  const quota = gbToBytes(10)

  it("is unlimited when there is no quota", () => {
    expect(computeQuotaStatus(gbToBytes(999), null, 80)).toBe("unlimited")
  })

  it("is ok well under the threshold", () => {
    expect(computeQuotaStatus(gbToBytes(5), quota, 80)).toBe("ok")
  })

  it("warns at or above the threshold", () => {
    expect(computeQuotaStatus(gbToBytes(8), quota, 80)).toBe("warning")
    expect(computeQuotaStatus(gbToBytes(9), quota, 80)).toBe("warning")
  })

  it("is over once usage reaches the quota", () => {
    expect(computeQuotaStatus(quota, quota, 80)).toBe("over")
    expect(computeQuotaStatus(gbToBytes(11), quota, 80)).toBe("over")
  })

  it("respects a custom warning threshold", () => {
    expect(computeQuotaStatus(gbToBytes(6), quota, 50)).toBe("warning")
    expect(computeQuotaStatus(gbToBytes(6), quota, 70)).toBe("ok")
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — the upload gate (decideUpload)
// ---------------------------------------------------------------------------

describe("decideUpload — within quota", () => {
  it("allows an upload that stays under the quota", () => {
    const d = decideUpload(gbToBytes(2), gbToBytes(1), gbToBytes(10), settings())
    expect(d.allowed).toBe(true)
    expect(d.wouldExceed).toBe(false)
    expect(d.status).toBe("ok")
    expect(d.remainingBytes).toBe(gbToBytes(8))
    expect(d.projectedBytes).toBe(gbToBytes(3))
  })

  it("reports a warning when the upload crosses the threshold but fits", () => {
    const d = decideUpload(gbToBytes(7), gbToBytes(1), gbToBytes(10), settings())
    expect(d.allowed).toBe(true)
    expect(d.status).toBe("warning")
    expect(d.wouldExceed).toBe(false)
  })
})

describe("decideUpload — unlimited", () => {
  it("always allows when the quota is unlimited", () => {
    const d = decideUpload(gbToBytes(9_999), gbToBytes(500), null, settings({ hardLimit: true }))
    expect(d.allowed).toBe(true)
    expect(d.status).toBe("unlimited")
    expect(d.quotaBytes).toBeNull()
    expect(d.remainingBytes).toBeNull()
  })
})

describe("decideUpload — over quota (the enforcement scenario)", () => {
  it("BLOCKS an over-quota upload when the hard limit is enabled", () => {
    const d = decideUpload(gbToBytes(9), gbToBytes(2), gbToBytes(10), settings({ hardLimit: true }))
    expect(d.wouldExceed).toBe(true)
    expect(d.allowed).toBe(false)
    expect(d.status).toBe("over")
    expect(d.reason).toContain("quota exceeded")
  })

  it("ALLOWS but flags an over-quota upload when the limit is soft", () => {
    const d = decideUpload(gbToBytes(9), gbToBytes(2), gbToBytes(10), settings({ hardLimit: false }))
    expect(d.wouldExceed).toBe(true)
    expect(d.allowed).toBe(true)
    expect(d.status).toBe("over")
  })

  it("never blocks when enforcement is switched off, even with a hard limit", () => {
    const d = decideUpload(gbToBytes(9), gbToBytes(5), gbToBytes(10), settings({ hardLimit: true, enforced: false }))
    expect(d.wouldExceed).toBe(true)
    expect(d.allowed).toBe(true)
  })

  it("blocks an upload that exactly tips over a hard quota", () => {
    const d = decideUpload(gbToBytes(10), 1, gbToBytes(10), settings({ hardLimit: true }))
    expect(d.allowed).toBe(false)
    expect(d.wouldExceed).toBe(true)
  })

  it("allows an upload that exactly fills a hard quota to the brim", () => {
    const d = decideUpload(gbToBytes(9), gbToBytes(1), gbToBytes(10), settings({ hardLimit: true }))
    expect(d.allowed).toBe(true)
    expect(d.wouldExceed).toBe(false)
    expect(d.remainingBytes).toBe(gbToBytes(1))
  })

  it("blocks every upload (even empty) against a zero custom quota under a hard limit", () => {
    const d = decideUpload(0, 1, 0, settings({ hardLimit: true }))
    expect(d.allowed).toBe(false)
  })
})
