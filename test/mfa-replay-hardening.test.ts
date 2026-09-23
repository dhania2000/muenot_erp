import { describe, expect, it } from "vitest"
import { generateTotpSecret, matchedTotpStep, totp, verifyTotp } from "@/lib/mfa"

describe("MFA TOTP replay step", () => {
  const secret = generateTotpSecret()
  const now = 1_700_000_000_000

  it("returns the exact accepted step for current and adjacent codes", () => {
    const current = Math.floor(now / 30_000)
    expect(matchedTotpStep(secret, totp(secret, now), { atMs: now })).toBe(current)
    expect(matchedTotpStep(secret, totp(secret, now - 30_000), { atMs: now })).toBe(current - 1)
    expect(matchedTotpStep(secret, totp(secret, now + 30_000), { atMs: now })).toBe(current + 1)
  })

  it("rejects malformed and out-of-window codes without changing verification behavior", () => {
    expect(matchedTotpStep(secret, "not-a-code", { atMs: now })).toBeNull()
    expect(matchedTotpStep(secret, totp(secret, now + 90_000), { atMs: now })).toBeNull()
    expect(verifyTotp(secret, totp(secret, now), { atMs: now })).toBe(true)
  })
})
