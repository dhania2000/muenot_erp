import { describe, expect, it } from "vitest"
import {
  BACKUP_ARTIFACT_VERSION,
  buildArtifactEnvelope,
  clampMinKeep,
  clampRetentionDays,
  computeExpiry,
  computeNextBackupRun,
  formatBytes,
  isBackupDue,
  isBackupExpired,
  isRestoreTestDue,
  parseArtifact,
  serializeArtifact,
  toBackupFrequency,
  toBackupScope,
  toRestoreTestFrequency,
  totalRowCount,
} from "@/lib/backup/model"

/**
 * SPEC 75 — Phase 4. Pure, DB-free validation of the backup model: scope /
 * frequency normalization, deterministic scheduling and retention math, the
 * artifact envelope round-trip + shape validation, and byte formatting. Fixed
 * clocks keep every time-based assertion deterministic.
 */

describe("normalization", () => {
  it("coerces scopes", () => {
    expect(toBackupScope("database")).toBe("database")
    expect(toBackupScope("files")).toBe("files")
    expect(toBackupScope("config")).toBe("config")
    expect(toBackupScope("nonsense")).toBeNull()
    expect(toBackupScope(42)).toBeNull()
  })

  it("defaults invalid frequency / restore cadence", () => {
    expect(toBackupFrequency("weekly")).toBe("weekly")
    expect(toBackupFrequency("hourly")).toBe("daily")
    expect(toRestoreTestFrequency("monthly")).toBe("monthly")
    expect(toRestoreTestFrequency("bad")).toBe("weekly")
    expect(toRestoreTestFrequency("none")).toBe("none")
  })
})

describe("retention clamps", () => {
  it("clamps retention days", () => {
    expect(clampRetentionDays(30)).toBe(30)
    expect(clampRetentionDays(0)).toBe(30) // default
    expect(clampRetentionDays(-5)).toBe(30)
    expect(clampRetentionDays(99999)).toBe(3650)
    expect(clampRetentionDays("abc")).toBe(30)
  })

  it("clamps min keep (allowing zero)", () => {
    expect(clampMinKeep(3)).toBe(3)
    expect(clampMinKeep(0)).toBe(0)
    expect(clampMinKeep(-1)).toBe(3)
    expect(clampMinKeep(1000)).toBe(100)
  })

  it("computes and detects expiry", () => {
    const created = new Date("2026-01-01T00:00:00Z")
    const expiry = computeExpiry(created, 10)
    expect(expiry.toISOString()).toBe("2026-01-11T00:00:00.000Z")
    expect(isBackupExpired(expiry, new Date("2026-01-10T00:00:00Z"))).toBe(false)
    expect(isBackupExpired(expiry, new Date("2026-01-12T00:00:00Z"))).toBe(true)
    expect(isBackupExpired(null)).toBe(false)
  })
})

describe("scheduling", () => {
  it("a never-run policy is always due", () => {
    expect(isBackupDue("daily", null, new Date("2026-01-01T09:00:00Z"))).toBe(true)
  })

  it("respects frequency spacing", () => {
    const lastRun = "2026-01-01T02:00:00Z"
    // Next daily boundary is 2026-01-02 02:00Z.
    expect(isBackupDue("daily", lastRun, new Date("2026-01-01T23:00:00Z"))).toBe(false)
    expect(isBackupDue("daily", lastRun, new Date("2026-01-02T02:30:00Z"))).toBe(true)
    // Weekly is not due the next day.
    expect(isBackupDue("weekly", lastRun, new Date("2026-01-02T02:30:00Z"))).toBe(false)
    expect(isBackupDue("weekly", lastRun, new Date("2026-01-09T02:30:00Z"))).toBe(true)
  })

  it("next run lands on the 02:00 UTC boundary", () => {
    const next = computeNextBackupRun("daily", "2026-03-01T02:00:00Z")
    expect(next.getUTCHours()).toBe(2)
    expect(next.getUTCMinutes()).toBe(0)
  })

  it("restore-test cadence", () => {
    expect(isRestoreTestDue("none", null)).toBe(false)
    expect(isRestoreTestDue("weekly", null)).toBe(true)
    const last = "2026-01-01T00:00:00Z"
    expect(isRestoreTestDue("weekly", last, new Date("2026-01-05T00:00:00Z"))).toBe(false)
    expect(isRestoreTestDue("weekly", last, new Date("2026-01-09T00:00:00Z"))).toBe(true)
    expect(isRestoreTestDue("monthly", last, new Date("2026-01-20T00:00:00Z"))).toBe(false)
    expect(isRestoreTestDue("monthly", last, new Date("2026-02-05T00:00:00Z"))).toBe(true)
  })
})

describe("artifact envelope", () => {
  it("round-trips and validates shape", () => {
    const envelope = buildArtifactEnvelope(
      "database",
      7,
      [{ name: "sales_leads", rowCount: 2, rows: [{ id: 1 }, { id: 2 }] }],
      new Date("2026-01-01T02:00:00Z"),
    )
    expect(envelope.version).toBe(BACKUP_ARTIFACT_VERSION)
    const json = serializeArtifact(envelope)
    const parsed = parseArtifact(json)
    expect(parsed).not.toBeNull()
    expect(parsed!.scope).toBe("database")
    expect(parsed!.tenantId).toBe(7)
    expect(parsed!.sections).toHaveLength(1)
    expect(totalRowCount(parsed!.sections)).toBe(2)
  })

  it("rejects malformed artifacts", () => {
    expect(parseArtifact("not json")).toBeNull()
    expect(parseArtifact(JSON.stringify({ scope: "bad", sections: [] }))).toBeNull()
    expect(parseArtifact(JSON.stringify({ scope: "database" }))).toBeNull()
    expect(parseArtifact(JSON.stringify({ scope: "database", sections: [{ rows: [] }] }))).toBeNull()
  })

  it("recovers rowCount from rows when missing", () => {
    const parsed = parseArtifact(
      JSON.stringify({ scope: "config", sections: [{ name: "tenant_settings", rows: [{ a: 1 }, { b: 2 }] }] }),
    )
    expect(parsed!.sections[0].rowCount).toBe(2)
  })
})

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB")
  })
})
