import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mock.query, pool: { getConnection: vi.fn() } }))

import { consumeMfaChallenge } from "@/lib/user-lifecycle"
import { totp } from "@/lib/mfa"
import { encryptSecret } from "@/lib/secrets/crypto"

describe("encrypted MFA challenge and one-time TOTP", () => {
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
  let lastUsedStep: number | null

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SETTINGS_ENCRYPTION_KEY = "test-only-mfa-encryption-key"
    lastUsedStep = null
    const encrypted = encryptSecret(secret)
    mock.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT mfa_secret FROM users WHERE id")) return [{ mfa_secret: encrypted }]
      if (sql.includes("UPDATE users SET mfa_last_used_step")) {
        const step = Number(params?.[0])
        if (lastUsedStep !== null && lastUsedStep >= step) return { affectedRows: 0 }
        lastUsedStep = step
        return { affectedRows: 1 }
      }
      return []
    })
  })

  it("accepts one encrypted-secret code and rejects its replay", async () => {
    const code = totp(secret)
    expect(await consumeMfaChallenge(42, code)).toBe(true)
    expect(await consumeMfaChallenge(42, code)).toBe(false)
    expect(mock.query.mock.calls.some(([sql]) => String(sql).includes("mfa_last_used_step < ?"))).toBe(true)
  })

  it("rejects concurrent duplicate consumption with an atomic update", async () => {
    const code = totp(secret)
    const results = await Promise.all([consumeMfaChallenge(42, code), consumeMfaChallenge(42, code)])
    expect(results.sort()).toEqual([false, true])
  })
})
