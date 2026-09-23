import { afterEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), provider: vi.fn(), state: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mock.get, set: mock.set, delete: mock.del }) }))
vi.mock("@/lib/sso-store", () => ({ getProviderById: mock.provider, recordLoginEvent: vi.fn() }))
vi.mock("@/lib/sso-saml", () => ({ createSaml: vi.fn() }))
vi.mock("@/lib/sso-state", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/sso-state")>()
  return { ...real, consumeSsoState: mock.state }
})

import { ssoOrigin } from "@/lib/sso-origin"
import { issueSsoState } from "@/lib/sso-state"
import { POST as samlAcs } from "@/app/api/auth/sso/[providerId]/saml/acs/route"
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it("uses configured APP_URL, not attacker-supplied forwarded host, for SSO callbacks", () => {
  vi.stubEnv("APP_URL", "https://erp.muenot.co.in")
  const request = new Request("https://erp.muenot.co.in/api/auth/sso/1/login", { headers: { "x-forwarded-host": "evil.example" } })
  expect(ssoOrigin(request)).toBe("https://erp.muenot.co.in")
})
it("rejects unsafe or missing production SSO origins", () => {
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("APP_URL", "http://erp.muenot.co.in")
  expect(() => ssoOrigin(new Request("https://erp.muenot.co.in"))).toThrow()
  vi.stubEnv("APP_URL", "")
  expect(() => ssoOrigin(new Request("https://erp.muenot.co.in"))).toThrow()
})
it("sets Secure SameSite=None for SAML POST callbacks and Lax for OIDC GET", async () => {
  vi.stubEnv("SESSION_SECRET", "a".repeat(48))
  await issueSsoState({ providerId: 1, protocol: "saml", state: "state", nonce: "nonce", redirectTo: "/dashboard" })
  expect(mock.set).toHaveBeenLastCalledWith("ems_sso_state", expect.any(String), expect.objectContaining({ sameSite: "none", secure: true, httpOnly: true }))
  await issueSsoState({ providerId: 1, protocol: "oidc", state: "state", nonce: "nonce", codeVerifier: "a".repeat(43), redirectTo: "/dashboard" })
  expect(mock.set).toHaveBeenLastCalledWith("ems_sso_state", expect.any(String), expect.objectContaining({ sameSite: "lax" }))
})
it("rejects a SAML RelayState issued for another provider before parsing assertions", async () => {
  vi.stubEnv("APP_URL", "https://erp.muenot.co.in")
  mock.provider.mockResolvedValue({ id: 2, type: "saml", status: "enabled" })
  mock.state.mockResolvedValue({ providerId: 1, protocol: "saml", state: "state", nonce: "nonce" })
  const result = await samlAcs(new Request("https://erp.muenot.co.in/api/auth/sso/2/saml/acs", { method: "POST" }), { params: Promise.resolve({ providerId: "2" }) })
  expect(result.status).toBe(307)
  expect(result.headers.get("location")).toContain("sso_error=unavailable")
})
