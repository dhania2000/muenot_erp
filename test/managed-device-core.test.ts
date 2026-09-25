import { describe, expect, it } from "vitest"
import {
  evaluateManagedDevice,
  issueAssertion,
  newDeviceId,
  verifyAssertion,
} from "@/lib/managed-device-core"

const SECRET = "test-signing-secret-value"

describe("issueAssertion / verifyAssertion", () => {
  it("round-trips a valid assertion", () => {
    const deviceId = newDeviceId()
    const token = issueAssertion({ deviceId, tenantId: 7, userId: 42 }, SECRET)
    const result = verifyAssertion(token, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.deviceId).toBe(deviceId)
      expect(result.claims.tenantId).toBe(7)
      expect(result.claims.userId).toBe(42)
    }
  })

  it("rejects a tampered payload (bad signature)", () => {
    const token = issueAssertion({ deviceId: "d1", tenantId: 1, userId: 1 }, SECRET)
    const [v, payload, sig] = token.split(".")
    const forgedPayload = Buffer.from(
      JSON.stringify({ deviceId: "d1", tenantId: 1, userId: 999, iat: 1, exp: 9999999999 }),
    ).toString("base64url")
    const result = verifyAssertion(`${v}.${forgedPayload}.${sig}`, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("bad_signature")
  })

  it("rejects a token signed with a different secret", () => {
    const token = issueAssertion({ deviceId: "d1", tenantId: 1, userId: 1 }, SECRET)
    const result = verifyAssertion(token, "another-secret")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("bad_signature")
  })

  it("rejects an expired token", () => {
    const past = new Date("2020-01-01T00:00:00Z")
    const token = issueAssertion({ deviceId: "d1", tenantId: 1, userId: 1, ttlSeconds: 60 }, SECRET, past)
    const result = verifyAssertion(token, SECRET, new Date("2020-01-02T00:00:00Z"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("expired")
  })

  it("rejects malformed input", () => {
    expect(verifyAssertion("", SECRET).ok).toBe(false)
    expect(verifyAssertion("a.b", SECRET).ok).toBe(false)
    expect(verifyAssertion(null, SECRET).ok).toBe(false)
    expect(verifyAssertion("v1..sig", SECRET).ok).toBe(false)
  })
})

describe("evaluateManagedDevice", () => {
  it("never denies when the tenant does not require managed devices", () => {
    expect(evaluateManagedDevice({ required: false }, "unknown").denied).toBe(false)
    expect(evaluateManagedDevice({ required: false }, "revoked").denied).toBe(false)
  })

  it("permits a verified device when required", () => {
    const d = evaluateManagedDevice({ required: true }, "verified")
    expect(d.denied).toBe(false)
    expect(d.reason).toBe("device_verified")
  })

  it("denies a revoked device when required", () => {
    const d = evaluateManagedDevice({ required: true }, "revoked")
    expect(d.denied).toBe(true)
    expect(d.reason).toBe("device_revoked")
  })

  it("denies when no valid assertion is presented and devices are required", () => {
    const d = evaluateManagedDevice({ required: true }, "unknown")
    expect(d.denied).toBe(true)
    expect(d.reason).toBe("assertion_missing")
  })
})
