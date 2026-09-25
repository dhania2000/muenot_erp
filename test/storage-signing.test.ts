import { beforeAll, describe, expect, it, vi } from "vitest"

/**
 * Spec7 — signed download-proxy tokens.
 *
 * The signed proxy URL is how a private customer object is served: a short-lived
 * HMAC bound to BOTH the object key and (because the tenant id is embedded in
 * the key) the owning tenant. Tests cover a valid token, expiry, tampering,
 * and the cross-tenant guarantee that a token for one tenant's key never
 * verifies for another.
 */

// Deterministic secret so signatures are stable within the run.
process.env.STORAGE_URL_SIGNING_SECRET = "test-signing-secret"

import { clampTtl, signedProxyUrl, verifySignedProxyToken } from "@/lib/storage/signing"

function parse(url: string): { key: string; exp: string; sig: string } {
  const [path, qs] = url.split("?")
  const params = new URLSearchParams(qs)
  // path is /api/storage/file/<encoded key segments>
  const key = path
    .replace("/api/storage/file/", "")
    .split("/")
    .map(decodeURIComponent)
    .join("/")
  return { key, exp: params.get("exp")!, sig: params.get("sig")! }
}

describe("clampTtl", () => {
  it("keeps in-range values, defaults invalid ones, caps the ceiling", () => {
    expect(clampTtl(60)).toBe(60)
    expect(clampTtl(0)).toBe(300)
    expect(clampTtl(undefined)).toBe(300)
    expect(clampTtl(60 * 60 * 48)).toBe(60 * 60 * 24)
  })
})

describe("signedProxyUrl / verifySignedProxyToken", () => {
  const key = "t/42/erp/report.pdf"

  it("verifies a freshly signed token and returns the bound tenant", () => {
    const { key: k, exp, sig } = parse(signedProxyUrl(key))
    const res = verifySignedProxyToken(k, exp, sig)
    expect(res).toEqual({ valid: true, tenantId: 42 })
  })

  it("rejects a missing token", () => {
    expect(verifySignedProxyToken(key, null, null)).toMatchObject({ valid: false, reason: "malformed" })
  })

  it("rejects an expired token", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-09-25T00:00:00Z"))
      const { exp, sig } = parse(signedProxyUrl(key, 60))
      vi.setSystemTime(new Date("2026-09-25T01:00:00Z")) // +1h, well past 60s
      expect(verifySignedProxyToken(key, exp, sig)).toMatchObject({ valid: false, reason: "expired" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects a tampered signature", () => {
    const { exp } = parse(signedProxyUrl(key))
    expect(verifySignedProxyToken(key, exp, "AAAAtampered")).toMatchObject({ valid: false, reason: "bad-signature" })
  })

  it("does NOT verify for a different tenant's key (cross-tenant)", () => {
    // Sign a token for tenant 42, then try to use it against tenant 43's key.
    const { exp, sig } = parse(signedProxyUrl("t/42/erp/report.pdf"))
    const res = verifySignedProxyToken("t/43/erp/report.pdf", exp, sig)
    expect(res).toMatchObject({ valid: false, reason: "bad-signature" })
  })

  it("rejects a validly-signed key with no tenant segment", () => {
    const { key: k, exp, sig } = parse(signedProxyUrl("global/config.json"))
    expect(verifySignedProxyToken(k, exp, sig)).toMatchObject({ valid: false, reason: "no-tenant" })
  })
})
