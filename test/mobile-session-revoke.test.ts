import { beforeEach, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn(), statements: [] as Array<{ sql: string; args: unknown[] }> }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mock.query, withTransaction: mock.tx }))
vi.mock("jose", () => ({ SignJWT: class {}, jwtVerify: vi.fn() }))
vi.mock("@/lib/password", () => ({ verifyPassword: vi.fn() }))
vi.mock("@/lib/password-policy", () => ({ checkLockout: vi.fn(), recordFailedLogin: vi.fn(), recordSuccessfulLogin: vi.fn() }))
vi.mock("@/lib/user-lifecycle", () => ({ getLoginSnapshot: vi.fn() }))
vi.mock("@/lib/user-lifecycle-core", () => ({ evaluateLogin: vi.fn() }))
vi.mock("@/lib/settings/server", () => ({ getPublicSettings: vi.fn() }))
vi.mock("@/lib/mfa-policy", () => ({ requiresMfaByPolicy: vi.fn() }))
vi.mock("@/lib/platform-roles", () => ({ getStoredRoles: vi.fn() }))
vi.mock("@/lib/tenant-service", () => ({ getTenantById: vi.fn() }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(), getClientIp: vi.fn() }))
import { revokeMobileSession } from "@/lib/mobile-auth"

beforeEach(() => {
  vi.clearAllMocks()
  mock.statements.length = 0
  mock.query.mockResolvedValue([])
  mock.tx.mockImplementation((fn: (connection: unknown) => Promise<unknown>) => fn({ query: async (sql: string,args: unknown[] = []) => { mock.statements.push({ sql,args }); return [{ affectedRows: 1 },{}] } }))
})

it("atomically revokes only the specified user/tenant/session and its own push devices", async () => {
  await revokeMobileSession("session-a",11,"logout",7)
  expect(mock.statements).toHaveLength(2)
  expect(mock.statements[0].sql).toContain("session_id=? AND user_id=? AND tenant_id=?")
  expect(mock.statements[0].args).toEqual(["logout","session-a",11,7])
  expect(mock.statements[1].sql).toContain("mobile_session_id=? AND user_id=? AND tenant_id=?")
  expect(mock.statements[1].args).toEqual(["session-a",11,7])
})

it("fails closed when a tenant context is not supplied", async () => {
  await expect(revokeMobileSession("session-a",11)).rejects.toThrow("Tenant context is required")
  expect(mock.tx).not.toHaveBeenCalled()
})
