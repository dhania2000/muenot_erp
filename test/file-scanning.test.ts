import { describe, expect, it } from "vitest"
import {
  FileDownloadBlockedError,
  HeuristicScanProvider,
  canDownload,
  detectSignatures,
  downloadGatePolicyFor,
  isApprovable,
  normalizeScanStatus,
  safetyFromStatus,
  type DownloadGatePolicy,
  type ScanRequest,
  type ScanStatus,
} from "@/lib/storage/file-scanning"

/**
 * Phase 4. Pure, DB-free validation of the malware / file-security
 * scanning layer: the lifecycle vocabulary, the safe/unsafe/unknown verdict,
 * the download gate across every lifecycle state, and the deterministic default
 * provider. The three scenarios the spec calls out — MALICIOUS (infected),
 * FAILED (scan error), and UNKNOWN (pending/scanning) — are each pinned down.
 */

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

describe("scan status normalization", () => {
  it("passes through the five known lifecycle states", () => {
    for (const s of ["pending", "scanning", "clean", "infected", "error"] as const) {
      expect(normalizeScanStatus(s)).toBe(s)
    }
  })

  it("falls back to pending for unknown/empty values", () => {
    expect(normalizeScanStatus("garbage")).toBe("pending")
    expect(normalizeScanStatus(null)).toBe("pending")
    expect(normalizeScanStatus(undefined)).toBe("pending")
  })
})

describe("safety verdict derivation", () => {
  it("maps clean → safe, infected → unsafe, everything else → unknown", () => {
    expect(safetyFromStatus("clean")).toBe("safe")
    expect(safetyFromStatus("infected")).toBe("unsafe")
    expect(safetyFromStatus("pending")).toBe("unknown")
    expect(safetyFromStatus("scanning")).toBe("unknown")
    expect(safetyFromStatus("error")).toBe("unknown")
  })
})

describe("approvability", () => {
  it("allows an administrator to release every uncertain state", () => {
    for (const s of ["pending", "scanning", "clean", "error"] as const) {
      expect(isApprovable(s)).toBe(true)
    }
  })

  it("never allows an infected file to be approved", () => {
    expect(isApprovable("infected")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Download gate policy
// ---------------------------------------------------------------------------

describe("download gate policy", () => {
  it("never gates public assets and fails open", () => {
    expect(downloadGatePolicyFor({ classification: "public" })).toEqual({
      blockUntilClean: false,
      failureMode: "fail_open",
    })
  })

  it("blocks internal/confidential/restricted until clean and fails closed", () => {
    for (const classification of ["internal", "confidential", "restricted"] as const) {
      expect(downloadGatePolicyFor({ classification })).toEqual({
        blockUntilClean: true,
        failureMode: "fail_closed",
      })
    }
  })

  it("gates unknown/missing classifications defensively (fail closed)", () => {
    expect(downloadGatePolicyFor({ classification: null as never })).toEqual({
      blockUntilClean: true,
      failureMode: "fail_closed",
    })
  })
})

// ---------------------------------------------------------------------------
// The core download gate — malicious / failed / unknown scenarios
// ---------------------------------------------------------------------------

const GATED: DownloadGatePolicy = { blockUntilClean: true, failureMode: "fail_closed" }
const GATED_OPEN: DownloadGatePolicy = { blockUntilClean: true, failureMode: "fail_open" }
const UNGATED: DownloadGatePolicy = { blockUntilClean: false, failureMode: "fail_open" }

describe("download gate — clean", () => {
  it("always allows a proven-clean file", () => {
    expect(canDownload({ scanStatus: "clean", approved: false }, GATED).allowed).toBe(true)
    expect(canDownload({ scanStatus: "clean", approved: false }, UNGATED).allowed).toBe(true)
  })
})

describe("download gate — MALICIOUS (infected)", () => {
  it("blocks an infected file even under an ungated policy", () => {
    const decision = canDownload({ scanStatus: "infected", approved: false }, UNGATED)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/infected/i)
  })

  it("blocks an infected file even when an admin marked it approved (terminal)", () => {
    expect(canDownload({ scanStatus: "infected", approved: true }, GATED).allowed).toBe(false)
  })
})

describe("download gate — FAILED (scan error)", () => {
  it("holds a failed scan under a fail-closed policy", () => {
    const decision = canDownload({ scanStatus: "error", approved: false }, GATED)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/awaiting administrator approval/i)
  })

  it("releases a failed scan under a fail-open policy", () => {
    const decision = canDownload({ scanStatus: "error", approved: false }, GATED_OPEN)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toMatch(/fail-open/i)
  })

  it("lets an administrator release a failed scan under fail-closed", () => {
    expect(canDownload({ scanStatus: "error", approved: true }, GATED).allowed).toBe(true)
  })
})

describe("download gate — UNKNOWN (pending / scanning)", () => {
  it("withholds a file that is still pending or scanning", () => {
    for (const scanStatus of ["pending", "scanning"] as const) {
      const decision = canDownload({ scanStatus, approved: false }, GATED)
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toMatch(/awaiting security scan/i)
    }
  })

  it("allows an administrator-released pending/scanning file", () => {
    expect(canDownload({ scanStatus: "pending", approved: true }, GATED).allowed).toBe(true)
    expect(canDownload({ scanStatus: "scanning", approved: true }, GATED).allowed).toBe(true)
  })

  it("allows pending/scanning when the policy does not gate downloads", () => {
    expect(canDownload({ scanStatus: "pending", approved: false }, UNGATED).allowed).toBe(true)
    expect(canDownload({ scanStatus: "scanning", approved: false }, UNGATED).allowed).toBe(true)
  })

  it("is total — every lifecycle state resolves to a defined decision", () => {
    const states: ScanStatus[] = ["pending", "scanning", "clean", "infected", "error"]
    for (const scanStatus of states) {
      for (const approved of [true, false]) {
        for (const policy of [GATED, GATED_OPEN, UNGATED]) {
          const decision = canDownload({ scanStatus, approved }, policy)
          expect(typeof decision.allowed).toBe("boolean")
          expect(decision.reason.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe("FileDownloadBlockedError", () => {
  it("carries a 403 status and the blocked marker", () => {
    const err = new FileDownloadBlockedError("nope")
    expect(err).toBeInstanceOf(Error)
    expect(err.blocked).toBe(true)
    expect(err.status).toBe(403)
    expect(err.message).toBe("nope")
  })
})

// ---------------------------------------------------------------------------
// Signature detection
// ---------------------------------------------------------------------------

describe("signature detection", () => {
  it("flags the industry-standard EICAR test string as critical", () => {
    const findings = detectSignatures(Buffer.from("prefix EICAR-STANDARD-ANTIVIRUS-TEST-FILE suffix"))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({ signature: "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", severity: "critical" })
  })

  it("flags the app's deterministic test marker", () => {
    const findings = detectSignatures(Buffer.from("payload V0-MALWARE-TEST payload"))
    expect(findings.map((f) => f.signature)).toContain("V0-Malware-Test-Marker")
  })

  it("returns no findings for benign content", () => {
    expect(detectSignatures(Buffer.from("a perfectly ordinary invoice.pdf"))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Default (replaceable) provider
// ---------------------------------------------------------------------------

function scanRequest(buffer: Buffer, overrides: Partial<ScanRequest> = {}): ScanRequest {
  return {
    fileId: 1,
    objectKey: "tenant/1/file",
    filename: "file.bin",
    mimeType: "application/octet-stream",
    size: buffer.length,
    read: async () => buffer,
    ...overrides,
  }
}

describe("HeuristicScanProvider", () => {
  const provider = new HeuristicScanProvider()

  it("returns a clean verdict for benign bytes", async () => {
    const outcome = await provider.scan(scanRequest(Buffer.from("hello world")))
    expect(outcome.verdict).toBe("clean")
    expect(outcome.provider).toBe("builtin-heuristic")
  })

  it("returns an infected verdict with findings for a known-bad marker (MALICIOUS)", async () => {
    const outcome = await provider.scan(scanRequest(Buffer.from("x V0-MALWARE-TEST x")))
    expect(outcome.verdict).toBe("infected")
    expect(outcome.findings?.length).toBeGreaterThan(0)
    expect(outcome.detail).toMatch(/V0-Malware-Test-Marker/)
  })

  it("returns an error verdict when the object exceeds the inline scan limit (FAILED)", async () => {
    const outcome = await provider.scan(
      scanRequest(Buffer.alloc(0), { size: provider.maxInlineBytes + 1 }),
    )
    expect(outcome.verdict).toBe("error")
    expect(outcome.detail).toMatch(/inline scan limit/i)
  })

  it("returns an error verdict when the bytes cannot be read (FAILED)", async () => {
    const outcome = await provider.scan(
      scanRequest(Buffer.from("x"), {
        read: async () => {
          throw new Error("storage unavailable")
        },
      }),
    )
    expect(outcome.verdict).toBe("error")
    expect(outcome.detail).toMatch(/could not read/i)
  })
})
