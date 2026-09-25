import { describe, expect, it } from "vitest"
import { normalizeChecksum } from "@/lib/storage/multipart-store"

/**
 * Spec11 — resumable upload checksum capture.
 *
 * A client-declared checksum for a large video upload is normalized to a
 * canonical lowercase 64-char hex sha256 digest (or rejected) so the completion
 * step can verify integrity and enqueue malware scanning against a trustworthy
 * digest.
 */

describe("normalizeChecksum", () => {
  it("accepts a 64-char hex sha256 digest", () => {
    const hex = "a".repeat(64)
    expect(normalizeChecksum(hex)).toBe(hex)
  })

  it("lowercases and trims the digest", () => {
    const hex = "A".repeat(64)
    expect(normalizeChecksum(`  ${hex}  `)).toBe("a".repeat(64))
  })

  it("rejects non-hex or wrong-length digests", () => {
    expect(normalizeChecksum("not-a-hash")).toBeNull()
    expect(normalizeChecksum("sha256:" + "a".repeat(64))).toBeNull()
    expect(normalizeChecksum("a".repeat(63))).toBeNull()
    expect(normalizeChecksum("a".repeat(65))).toBeNull()
  })

  it("treats empty / nullish as no checksum", () => {
    expect(normalizeChecksum(null)).toBeNull()
    expect(normalizeChecksum(undefined)).toBeNull()
    expect(normalizeChecksum("   ")).toBeNull()
  })
})
