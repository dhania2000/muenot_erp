import { beforeEach, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn(), encrypt: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mock.query, withTransaction: mock.tx }))
vi.mock("@/lib/token-crypto", () => ({ encryptToken: mock.encrypt }))
import { registerMobileDevice, unregisterMobileDevice } from "@/lib/mobile-devices"

beforeEach(() => {
  vi.clearAllMocks()
  mock.encrypt.mockReturnValue("enc:v1:encrypted")
  mock.query.mockResolvedValue({ affectedRows: 1 })
  mock.tx.mockImplementation((fn: (connection: unknown) => Promise<unknown>) => fn({
    query: vi.fn().mockImplementation((sql: string) => Promise.resolve(sql.includes("GET_LOCK") ? [[{ acquired: 1 }],{}] : [[],{}])),
  }))
})

it("registers multiple installation IDs while the server supplies user and tenant identity", async () => {
  await registerMobileDevice({ tenantId: 7,userId: 11,sessionId: "session-a",deviceId: "install-a",token: "a".repeat(40),platform: "android",appVersion: "1.2.0" })
  await registerMobileDevice({ tenantId: 7,userId: 11,sessionId: "session-a",deviceId: "install-b",token: "b".repeat(40),platform: "android" })
  expect(mock.tx).toHaveBeenCalledTimes(2)
})

it("updates the same installation when its FCM token rotates", async () => {
  const transaction = vi.fn().mockImplementation((sql: string) => Promise.resolve(sql.includes("GET_LOCK") ? [[{ acquired: 1 }],{}] : [[{ id: 1,tenant_id: 7,user_id: 11,device_id: "install-a",enabled: 1 }],{}]))
  mock.tx.mockImplementationOnce((fn: (connection: unknown) => Promise<unknown>) => fn({ query: transaction }))
  await registerMobileDevice({ tenantId: 7,userId: 11,sessionId: "session-new",deviceId: "install-a",token: "new-token".repeat(8),platform: "android" })
  expect(transaction).toHaveBeenCalledWith(expect.stringContaining("ON DUPLICATE KEY UPDATE"), expect.arrayContaining(["session-new"]))
})

it("rejects a token active in another tenant or installation and only revokes the caller's session device", async () => {
  const transaction = vi.fn().mockImplementation((sql: string) => Promise.resolve(sql.includes("GET_LOCK") ? [[{ acquired: 1 }],{}] : [[{ id: 1,tenant_id: 8,user_id: 11,device_id: "other",enabled: 1 }],{}]))
  mock.tx.mockImplementationOnce((fn: (connection: unknown) => Promise<unknown>) => fn({ query: transaction }))
  await expect(registerMobileDevice({ tenantId: 7,userId: 11,sessionId: "session-a",deviceId: "install-a",token: "a".repeat(40) })).rejects.toThrow("different installation")
  await unregisterMobileDevice({ tenantId: 7,userId: 11,sessionId: "session-a",deviceId: "install-a" })
  expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("mobile_session_id=?"), [7,11,"session-a","install-a"])
})
