import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ geo: vi.fn(), device: vi.fn(), breakGlass: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/geo-policy-store", () => ({ enforceGeoPolicy: m.geo }))
vi.mock("@/lib/managed-device-store", () => ({ enforceManagedDevice: m.device }))
vi.mock("@/lib/temporary-access-store", () => ({ listActiveBreakGlassForUser: m.breakGlass }))

import { resolveTrustedGeo, resolveGeoTrustSource } from "@/lib/geo-trust"
import { enforceSignInProtection, resolveEmergencyAuthorization } from "@/lib/sign-in-protection"

const h = (o: Record<string, string>) => new Headers(o)
const vercel = { VERCEL: "1" }

describe("trusted geolocation (VPN / unknown IP)", () => {
  it("ignores a spoofable geo header when no trusted source is declared", () => {
    expect(resolveGeoTrustSource({})).toBe("none")
    const g = resolveTrustedGeo(h({ "x-vercel-ip-country": "US" }), "8.8.8.8", {})
    expect(g).toMatchObject({ country: null, reason: "untrusted_source" })
  })
  it("resolves a real country from the trusted Vercel edge", () => {
    expect(resolveTrustedGeo(h({ "x-vercel-ip-country": "in" }), "49.36.1.1", vercel)).toMatchObject({ country: "IN", reason: "resolved" })
  })
  it("does not honour a cloudflare header unless explicitly configured", () => {
    expect(resolveTrustedGeo(h({ "cf-ipcountry": "DE" }), "1.1.1.1", vercel).country).toBeNull()
    expect(resolveTrustedGeo(h({ "cf-ipcountry": "DE" }), "1.1.1.1", { GEO_TRUSTED_SOURCE: "cloudflare" }).country).toBe("DE")
  })
  it("treats Tor / anonymous-proxy codes as unknown + anonymous", () => {
    for (const code of ["T1", "A1"]) {
      expect(resolveTrustedGeo(h({ "x-vercel-ip-country": code }), "5.5.5.5", vercel)).toMatchObject({ country: null, anonymous: true })
    }
    expect(resolveTrustedGeo(h({ "x-vercel-ip-country": "XX" }), "5.5.5.5", vercel)).toMatchObject({ country: null, anonymous: false })
  })
  it("treats a trusted VPN flag header as unknown even with a country", () => {
    const env = { ...vercel, GEO_ANONYMIZER_HEADER: "x-geo-anonymous" }
    expect(resolveTrustedGeo(h({ "x-vercel-ip-country": "US", "x-geo-anonymous": "vpn" }), "9.9.9.9", env)).toMatchObject({ country: null, anonymous: true, reason: "anonymizer" })
  })
  it("treats private / loopback / missing IP geo as unknown", () => {
    for (const ip of ["10.1.2.3", "192.168.0.4", "127.0.0.1", "::1", "100.64.0.1"]) {
      expect(resolveTrustedGeo(h({ "x-vercel-ip-country": "US" }), ip, vercel).reason).toBe("private_ip")
    }
    expect(resolveTrustedGeo(h({}), "8.8.8.8", vercel).reason).toBe("missing_header")
  })
})

const base = {
  tenantId: 10,
  user: { id: 5, name: "U", email: "u@t.test" },
  platformRole: null,
  ip: "8.8.8.8",
  geo: { country: null, source: "vercel" as const, anonymous: true, reason: "anonymizer" as const },
  deviceAssertion: undefined,
}

describe("sign-in protection orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.breakGlass.mockResolvedValue([])
    m.geo.mockResolvedValue({ denied: false, bypassed: false })
    m.device.mockResolvedValue({ denied: false, bypassed: false })
  })

  it("denies with GEO_BLOCKED and skips the device check", async () => {
    m.geo.mockResolvedValue({ denied: true, bypassed: false })
    const r = await enforceSignInProtection(base)
    expect(r).toMatchObject({ ok: false, code: "GEO_BLOCKED", status: 403 })
    expect(m.device).not.toHaveBeenCalled()
    expect(m.geo.mock.calls[0][1]).toMatchObject({ country: null, emergencyAuthorized: false, locationMeta: { anonymous: true, resolution: "anonymizer" } })
  })
  it("denies with MANAGED_DEVICE_REQUIRED (e.g. a revoked device)", async () => {
    m.device.mockResolvedValue({ denied: true, bypassed: false })
    expect(await enforceSignInProtection({ ...base, deviceAssertion: "revoked-token" })).toMatchObject({ ok: false, code: "MANAGED_DEVICE_REQUIRED" })
    expect(m.device.mock.calls[0][1]).toMatchObject({ assertion: "revoked-token" })
  })
  it("authorizes emergency access via an active break-glass grant and reports bypasses", async () => {
    m.breakGlass.mockResolvedValue([{ id: 77 }])
    m.geo.mockResolvedValue({ denied: false, bypassed: true })
    const r = await enforceSignInProtection(base)
    expect(r).toMatchObject({ ok: true, bypassed: ["geo"], emergency: { authorized: true, via: "break_glass_grant", grantId: 77 } })
    expect(m.geo.mock.calls[0][1]).toMatchObject({ emergencyAuthorized: true, emergencyGrantId: 77 })
  })
  it("platform super admins are emergency-authorized without a grant", async () => {
    expect(await resolveEmergencyAuthorization(10, 5, "platform_super_admin")).toMatchObject({ authorized: true, via: "platform_super_admin" })
    expect(m.breakGlass).not.toHaveBeenCalled()
  })
  it("fails closed when the break-glass lookup errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    m.breakGlass.mockRejectedValue(new Error("db down"))
    expect(await resolveEmergencyAuthorization(10, 5, null)).toMatchObject({ authorized: false })
  })
  it("never authorizes emergency access without a tenant", async () => {
    expect(await resolveEmergencyAuthorization(null, 5, "tenant_admin")).toMatchObject({ authorized: false })
  })
})

describe("platform security context (server-authoritative)", () => {
  it("classifies only from the DB role and break-glass config", async () => {
    const { resolvePlatformSecurityContext } = await import("@/lib/sign-in-protection")
    const prev = process.env.PLATFORM_BREAK_GLASS_USER_IDS
    process.env.PLATFORM_BREAK_GLASS_USER_IDS = "42"
    try {
      expect(resolvePlatformSecurityContext(1, "platform_super_admin")).toMatchObject({
        accountClass: "platform_super_admin",
        policyLevel: "platform_admin",
        exemptFromTenantDevicePolicy: true,
      })
      expect(resolvePlatformSecurityContext(42, "none")).toMatchObject({
        accountClass: "break_glass_platform_admin",
        policyLevel: "platform_emergency",
      })
      expect(resolvePlatformSecurityContext(2, "tenant_owner")).toMatchObject({
        accountClass: "normal",
        exemptFromTenantDevicePolicy: false,
      })
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_BREAK_GLASS_USER_IDS
      else process.env.PLATFORM_BREAK_GLASS_USER_IDS = prev
    }
  })
})
