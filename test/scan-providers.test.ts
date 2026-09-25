import { describe, expect, it, vi } from "vitest"
import {
  ClamAvScanProvider,
  ScanTimeoutError,
  parseClamdResponse,
  resolveScanProviderFromEnv,
  runWithScanTimeout,
  type ClamdTransport,
} from "@/lib/storage/scan-providers"
import type { ScanRequest } from "@/lib/storage/file-scanning"

/**
 * Production scanning backend: the ClamAV (clamd) adapter, the clamd response
 * PARSER, the shared scan TIMEOUT guard, and the env-driven factory. The spec's
 * INFECTED, PARSER-ERROR and TIMEOUT scenarios are each pinned down here without
 * a live clamd (the network transport is injected).
 */

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

// ---------------------------------------------------------------------------
// clamd response parser (pure, total)
// ---------------------------------------------------------------------------

describe("parseClamdResponse", () => {
  it("parses a clean INSTREAM reply", () => {
    expect(parseClamdResponse("stream: OK")).toEqual({ verdict: "clean", signature: null, detail: null })
  })

  it("parses an infected reply and extracts the signature", () => {
    const parsed = parseClamdResponse("stream: Win.Test.EICAR_HDB-1 FOUND")
    expect(parsed.verdict).toBe("infected")
    expect(parsed.signature).toBe("Win.Test.EICAR_HDB-1")
    expect(parsed.detail).toMatch(/FOUND/)
  })

  it("handles a trailing NUL terminator in clamd replies", () => {
    const parsed = parseClamdResponse("stream: Eicar-Signature FOUND\0")
    expect(parsed.verdict).toBe("infected")
    expect(parsed.signature).toBe("Eicar-Signature")
  })

  it("treats an explicit clamd ERROR line as an error verdict (PARSER)", () => {
    const parsed = parseClamdResponse("INSTREAM size limit exceeded ERROR")
    expect(parsed.verdict).toBe("error")
    expect(parsed.detail).toMatch(/ERROR/)
  })

  it("treats an empty response as an error verdict (PARSER)", () => {
    expect(parseClamdResponse("").verdict).toBe("error")
    expect(parseClamdResponse("   \0  ").verdict).toBe("error")
  })

  it("treats an unrecognized/garbled response as an error verdict (PARSER)", () => {
    const parsed = parseClamdResponse("this is not a clamd reply")
    expect(parsed.verdict).toBe("error")
    expect(parsed.detail).toMatch(/unrecognized/i)
  })
})

// ---------------------------------------------------------------------------
// Shared scan timeout guard
// ---------------------------------------------------------------------------

describe("runWithScanTimeout", () => {
  it("resolves when the scan finishes before the deadline", async () => {
    await expect(runWithScanTimeout(Promise.resolve("done"), 1000)).resolves.toBe("done")
  })

  it("rejects with ScanTimeoutError when the scan exceeds the deadline (TIMEOUT)", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 50))
    await expect(runWithScanTimeout(slow, 5)).rejects.toBeInstanceOf(ScanTimeoutError)
  })

  it("passes a settled promise straight through when the guard is disabled", async () => {
    await expect(runWithScanTimeout(Promise.resolve("x"), 0)).resolves.toBe("x")
    await expect(runWithScanTimeout(Promise.resolve("y"), -1)).resolves.toBe("y")
  })

  it("propagates a rejection unchanged when it happens before the deadline", async () => {
    await expect(runWithScanTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom")
  })
})

// ---------------------------------------------------------------------------
// ClamAV adapter (transport injected — no live clamd)
// ---------------------------------------------------------------------------

const config = { host: "clamav", port: 3310 }

describe("ClamAvScanProvider", () => {
  it("returns a clean verdict on a clamd OK reply", async () => {
    const transport: ClamdTransport = async () => "stream: OK"
    const provider = new ClamAvScanProvider(config, transport)
    const outcome = await provider.scan(scanRequest(Buffer.from("benign")))
    expect(outcome.verdict).toBe("clean")
    expect(outcome.provider).toBe("clamav")
  })

  it("returns an infected verdict with the signature as a finding (INFECTED)", async () => {
    const transport: ClamdTransport = async () => "stream: Win.Test.EICAR_HDB-1 FOUND"
    const provider = new ClamAvScanProvider(config, transport)
    const outcome = await provider.scan(scanRequest(Buffer.from("bad")))
    expect(outcome.verdict).toBe("infected")
    expect(outcome.findings).toEqual([{ signature: "Win.Test.EICAR_HDB-1", severity: "critical" }])
  })

  it("streams the object bytes to the transport", async () => {
    const transport = vi.fn<ClamdTransport>(async () => "stream: OK")
    const provider = new ClamAvScanProvider(config, transport)
    const bytes = Buffer.from("payload-bytes")
    await provider.scan(scanRequest(bytes))
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][1].equals(bytes)).toBe(true)
  })

  it("maps a clamd ERROR reply to an error verdict, never a false clean (PARSER)", async () => {
    const transport: ClamdTransport = async () => "size limit exceeded ERROR"
    const provider = new ClamAvScanProvider(config, transport)
    const outcome = await provider.scan(scanRequest(Buffer.from("x")))
    expect(outcome.verdict).toBe("error")
  })

  it("maps a scanner timeout to an error verdict (fail-closed, never a throw) (TIMEOUT)", async () => {
    const transport: ClamdTransport = async () => {
      throw new ScanTimeoutError("clamd did not respond")
    }
    const provider = new ClamAvScanProvider(config, transport)
    const outcome = await provider.scan(scanRequest(Buffer.from("x")))
    expect(outcome.verdict).toBe("error")
    expect(outcome.detail).toMatch(/timed out/i)
  })

  it("maps a connection failure to an error verdict, never a throw (OUTAGE)", async () => {
    const transport: ClamdTransport = async () => {
      throw new Error("ECONNREFUSED")
    }
    const provider = new ClamAvScanProvider(config, transport)
    const outcome = await provider.scan(scanRequest(Buffer.from("x")))
    expect(outcome.verdict).toBe("error")
    expect(outcome.detail).toMatch(/unavailable/i)
  })

  it("returns an error verdict when the stored bytes cannot be read (FAILED)", async () => {
    const transport = vi.fn<ClamdTransport>(async () => "stream: OK")
    const provider = new ClamAvScanProvider(config, transport)
    const outcome = await provider.scan(
      scanRequest(Buffer.from("x"), {
        read: async () => {
          throw new Error("storage down")
        },
      }),
    )
    expect(outcome.verdict).toBe("error")
    expect(outcome.detail).toMatch(/could not read/i)
    expect(transport).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Env-driven factory
// ---------------------------------------------------------------------------

describe("resolveScanProviderFromEnv", () => {
  it("returns null (keep built-in heuristic) when no scanner is configured", () => {
    expect(resolveScanProviderFromEnv({})).toBeNull()
    expect(resolveScanProviderFromEnv({ STORAGE_MALWARE_SCANNER: "" })).toBeNull()
  })

  it("selects the ClamAV backend when configured with a host", () => {
    const provider = resolveScanProviderFromEnv({
      STORAGE_MALWARE_SCANNER: "clamav",
      CLAMAV_HOST: "clamav.internal",
      CLAMAV_PORT: "3310",
    })
    expect(provider).toBeInstanceOf(ClamAvScanProvider)
    expect(provider?.id).toBe("clamav")
  })

  it("accepts the 'clamd' alias", () => {
    const provider = resolveScanProviderFromEnv({ STORAGE_MALWARE_SCANNER: "clamd", CLAMAV_HOST: "host" })
    expect(provider).toBeInstanceOf(ClamAvScanProvider)
  })

  it("falls back to the built-in heuristic when clamav is selected without a host", () => {
    expect(resolveScanProviderFromEnv({ STORAGE_MALWARE_SCANNER: "clamav" })).toBeNull()
    expect(resolveScanProviderFromEnv({ STORAGE_MALWARE_SCANNER: "clamav", CLAMAV_HOST: "  " })).toBeNull()
  })

  it("ignores an unrecognized scanner kind", () => {
    expect(resolveScanProviderFromEnv({ STORAGE_MALWARE_SCANNER: "sophos", CLAMAV_HOST: "host" })).toBeNull()
  })
})
