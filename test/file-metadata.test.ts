import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import {
  CLASSIFICATION_OPTIONS,
  DEFAULT_CLASSIFICATION,
  DEFAULT_RETENTION_POLICY,
  RETENTION_POLICIES,
  classificationRank,
  computeRetentionExpiry,
  isClassification,
  isRetentionExpired,
  isRetentionPolicy,
  normalizeClassification,
  normalizeRetentionPolicy,
  retentionDays,
} from "@/lib/storage/file-metadata-policy"
import {
  checksumMatches,
  formatFileRef,
  normalizeEncryptionState,
  normalizeUploadStatus,
  sha256,
} from "@/lib/storage/file-metadata"

/**
 * Phase 4. Pure, DB-free validation of the centralized file metadata
 * governance layer: integrity hashing, classification vocabulary, and the
 * retention policy → concrete expiry → lifecycle-eligibility pipeline. Uses
 * fixed clocks so the time-based assertions are deterministic.
 */

// ---------------------------------------------------------------------------
// Integrity (hashing)
// ---------------------------------------------------------------------------

describe("integrity — SHA-256 hashing", () => {
  it("matches Node's canonical lowercase-hex digest", () => {
    const data = Buffer.from("muenot erp file contents", "utf8")
    const expected = createHash("sha256").update(data).digest("hex")
    expect(sha256(data)).toBe(expected)
    expect(sha256(data)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is stable and content-sensitive", () => {
    const a = sha256(Buffer.from("same"))
    const b = sha256(Buffer.from("same"))
    const c = sha256(Buffer.from("different"))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("verifies integrity case-insensitively and fails closed on missing hashes", () => {
    const hash = sha256(Buffer.from("payload"))
    expect(checksumMatches(hash, hash)).toBe(true)
    expect(checksumMatches(hash.toUpperCase(), hash)).toBe(true)
    expect(checksumMatches(hash, "deadbeef")).toBe(false)
    expect(checksumMatches(null, hash)).toBe(false)
    expect(checksumMatches(hash, undefined)).toBe(false)
    expect(checksumMatches(null, null)).toBe(false)
  })

  it("detects tampering when the stored bytes change", () => {
    const original = sha256(Buffer.from("invoice-v1"))
    const tampered = sha256(Buffer.from("invoice-v1 (edited)"))
    expect(checksumMatches(original, tampered)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// File references
// ---------------------------------------------------------------------------

describe("file references", () => {
  it("zero-pads to a stable width", () => {
    expect(formatFileRef(1)).toBe("FILE-000001")
    expect(formatFileRef(42)).toBe("FILE-000042")
    expect(formatFileRef(1234567)).toBe("FILE-1234567")
  })
})

// ---------------------------------------------------------------------------
// Upload status
// ---------------------------------------------------------------------------

describe("upload status normalization", () => {
  it("passes through known statuses", () => {
    for (const s of ["pending", "uploading", "completed", "failed", "deleted"] as const) {
      expect(normalizeUploadStatus(s)).toBe(s)
    }
  })

  it("falls back to pending for unknown/empty values", () => {
    expect(normalizeUploadStatus("garbage")).toBe("pending")
    expect(normalizeUploadStatus(null)).toBe("pending")
    expect(normalizeUploadStatus(undefined)).toBe("pending")
  })
})

// ---------------------------------------------------------------------------
// Encryption-at-rest state (recorded per file)
// ---------------------------------------------------------------------------

describe("encryption state normalization", () => {
  it("passes through the four known states", () => {
    for (const s of ["unknown", "none", "AES256", "aws:kms"] as const) {
      expect(normalizeEncryptionState(s)).toBe(s)
    }
  })

  it("falls back to 'unknown' for unrecognized/empty values (fail safe)", () => {
    expect(normalizeEncryptionState("rot13")).toBe("unknown")
    expect(normalizeEncryptionState("")).toBe("unknown")
    expect(normalizeEncryptionState(null)).toBe("unknown")
    expect(normalizeEncryptionState(undefined)).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classification", () => {
  it("recognizes the four tiers and rejects others", () => {
    expect(isClassification("public")).toBe(true)
    expect(isClassification("restricted")).toBe(true)
    expect(isClassification("top-secret")).toBe(false)
  })

  it("normalizes unknown values to the internal default", () => {
    expect(normalizeClassification("confidential")).toBe("confidential")
    expect(normalizeClassification(null)).toBe(DEFAULT_CLASSIFICATION)
    expect(normalizeClassification("nope")).toBe("internal")
  })

  it("orders tiers by ascending sensitivity", () => {
    expect(classificationRank("public")).toBeLessThan(classificationRank("internal"))
    expect(classificationRank("internal")).toBeLessThan(classificationRank("confidential"))
    expect(classificationRank("confidential")).toBeLessThan(classificationRank("restricted"))
  })

  it("exposes a UI option for every tier", () => {
    const values = CLASSIFICATION_OPTIONS.map((o) => o.value).sort()
    expect(values).toEqual(["confidential", "internal", "public", "restricted"])
  })
})

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("retention policy", () => {
  it("defaults to a 7-year statutory floor", () => {
    expect(DEFAULT_RETENTION_POLICY).toBe("default")
    expect(retentionDays("default")).toBe(365 * 7)
    expect(normalizeRetentionPolicy("garbage")).toBe("default")
    expect(normalizeRetentionPolicy(null)).toBe("default")
  })

  it("validates known policy ids", () => {
    expect(isRetentionPolicy("30d")).toBe(true)
    expect(isRetentionPolicy("permanent")).toBe(true)
    expect(isRetentionPolicy("forever")).toBe(false)
  })

  it("computes a concrete expiry N days out for a fixed anchor", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    const expiry = computeRetentionExpiry("30d", from)
    expect(expiry).not.toBeNull()
    expect(expiry!.toISOString()).toBe("2026-01-31T00:00:00.000Z")
  })

  it("returns null (never expires) for a permanent policy", () => {
    expect(computeRetentionExpiry("permanent", new Date("2026-01-01"))).toBeNull()
    expect(RETENTION_POLICIES.permanent.days).toBeNull()
  })

  it("marks a file eligible for purge only once its expiry has passed", () => {
    const now = new Date("2026-02-01T00:00:00.000Z")
    const past = computeRetentionExpiry("30d", new Date("2025-12-01T00:00:00.000Z"))
    const future = computeRetentionExpiry("1y", now)
    expect(isRetentionExpired(past, now)).toBe(true)
    expect(isRetentionExpired(future, now)).toBe(false)
    // Permanent files (null expiry) and legal holds are never expired here.
    expect(isRetentionExpired(null, now)).toBe(false)
    expect(isRetentionExpired("not-a-date", now)).toBe(false)
  })

  it("treats an expiry exactly at now as expired (inclusive boundary)", () => {
    const now = new Date("2026-03-15T12:00:00.000Z")
    expect(isRetentionExpired(now, now)).toBe(true)
  })
})
