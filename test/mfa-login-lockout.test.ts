import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({
  query: vi.fn(), verify: vi.fn(), failed: vi.fn(), success: vi.fn(), consume: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ query: mock.query }))
vi.mock("@/lib/password", () => ({ verifyPassword: mock.verify }))
vi.mock("@/lib/auth", () => ({ createSessionToken: vi.fn(), setSessionCookie: vi.fn() }))
vi.mock("@/lib/settings/server", () => ({ getBool: async () => false, getNum: async () => 480, getPublicSettings: async () => ({}) }))
vi.mock("@/lib/notifications", () => ({ recordActivity: vi.fn() }))
vi.mock("@/lib/tenant-service", () => ({ resolveTenantIdForUser: async () => 7 }))
vi.mock("@/lib/platform-roles", () => ({ getStoredRoles: async () => null }))
vi.mock("@/lib/user-lifecycle-core", () => ({ evaluateLogin: () => ({ allowed: true, requiresMfa: true }) }))
vi.mock("@/lib/user-lifecycle", () => ({
  getLoginSnapshot: async () => ({ lifecycleState: "active", accessExpiresAt: null, emailVerifiedAt: "2026-01-01", mfaEnabled: true }),
  consumeMfaChallenge: mock.consume,
}))
vi.mock("@/lib/session-store", () => ({ createSession: vi.fn(), newSessionId: () => "test-session", isKnownDevice: async () => null }))
vi.mock("@/lib/mfa-policy", () => ({ requiresMfaByPolicy: () => true, requiresPhishingResistantMfa: () => false }))
vi.mock("@/lib/security-alerts-store", () => ({ onFailedLogin: vi.fn(async () => {}), onSuccessfulLogin: vi.fn(async () => {}) }))
vi.mock("@/lib/password-policy", () => ({ checkLockout: async () => ({ locked: false }), recordFailedLogin: mock.failed, recordSuccessfulLogin: mock.success }))
vi.mock("@/lib/ip-allowlist-store", () => ({ checkIpAllowlist: vi.fn() }))
vi.mock("@/lib/security-audit-store", () => ({ recordSecurityEvent: vi.fn() }))
vi.mock("@/lib/access-policy-store", () => ({ evaluateAccessPolicies: async () => ({ denied: false, deniedByPolicy: null, requireMfa: false, requireReauth: false, matched: [] }) }))

import { POST } from "@/app/api/auth/login/route"

beforeEach(() => {
  vi.clearAllMocks()
  process.env.DB_HOST = "test-db"
  process.env.DB_USER = "test-user"
  process.env.DB_NAME = "test-name"
  mock.query.mockResolvedValue([{ id: 42, name: "User", email: "user@example.test", password_hash: "hash", role: "admin", status: "active", must_change_password: 0 }])
  mock.verify.mockResolvedValue(true)
  mock.consume.mockResolvedValue(false)
})

function login(mfaCode?: string) {
  return POST(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.test", password: "correct-password", mfaCode }) }))
}

describe("MFA login lockout", () => {
  it("does not clear failed attempts at the password-only stage", async () => {
    const response = await login()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mfaRequired: true })
    expect(mock.success).not.toHaveBeenCalled()
  })

  it("counts invalid MFA codes as failed sign-in attempts", async () => {
    const response = await login("000000")
    expect(response.status).toBe(401)
    expect(mock.failed).toHaveBeenCalledWith(42)
    expect(mock.success).not.toHaveBeenCalled()
  })
})
