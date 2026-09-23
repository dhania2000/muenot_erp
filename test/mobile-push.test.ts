import { beforeEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const mock = vi.hoisted(() => ({ query: vi.fn(), enqueue: vi.fn(), tx: vi.fn(), decrypt: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mock.query, withTransaction: mock.tx }))
vi.mock("@/lib/mobile-auth", () => ({ ensureMobileAuthSchema: vi.fn() }))
vi.mock("@/lib/platform-roles", () => ({ ensurePlatformRoleSchema: vi.fn() }))
vi.mock("@/lib/notification-engine/schema", () => ({ ensureNotificationEngineSchema: vi.fn() }))
vi.mock("@/lib/notification-engine/service", () => ({ enqueueNotification: mock.enqueue }))
vi.mock("@/lib/token-crypto", () => ({ decryptToken: mock.decrypt }))
vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: class {
        async getClient() { return { getAccessToken: async () => ({ token: "server-oauth" }) } }
      },
    },
  },
}))

import { enqueueWhatsAppMessageNotifications } from "@/lib/whatsapp-push-notifications"
import { sendFcmNotification } from "@/lib/fcm-provider"

beforeEach(() => {
  vi.clearAllMocks()
  process.env.FCM_PROJECT_ID = "project-test"
  process.env.FCM_CLIENT_EMAIL = "push@example.test"
  process.env.FCM_PRIVATE_KEY = "private-key"
  mock.tx.mockImplementation((fn: (connection: unknown) => Promise<unknown>) => fn({}))
  mock.enqueue.mockResolvedValue(1)
  mock.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM users")) return [{ id: 11 }]
    if (sql.includes("SELECT id FROM marketing_whatsapp_messages")) return [{ id: 101 }]
    if (sql.includes("SELECT id,token_encrypted")) return [{ id: 1, token_encrypted: "encrypted-1" }, { id: 2, token_encrypted: "encrypted-2" }]
    return { affectedRows: 1 }
  })
  mock.decrypt.mockImplementation((token: string) => token === "encrypted-1" ? "fcm-device-token-1" : "fcm-device-token-2")
})

it("queues both in-app history and push once per eligible tenant member with a stable dedupe key", async () => {
  const input = { tenantId: 7, wamid: "wamid.abc", conversationId: 5, assignedAgentId: 12, contactName: "Customer", preview: "Hello" }
  await enqueueWhatsAppMessageNotifications(input)
  expect(mock.enqueue).toHaveBeenCalledTimes(4)
  const key = `whatsapp-inbound:${createHash("sha256").update("wamid.abc").digest("hex")}`
  expect(mock.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: 7,userId: 11,channel: "push",key }))
  expect(mock.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: 7,userId: 12,channel: "in_app" }))
  expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("WHERE tenant_id=? AND status='active'"), [7])
  await enqueueWhatsAppMessageNotifications(input) // Webhook retries reuse the request key.
  expect(mock.enqueue).toHaveBeenCalledTimes(8)
  expect(mock.enqueue.mock.calls[0][1].context).toMatchObject({ eventType: "whatsapp_message",conversationId: "5",messageId: "101" })
})

it("sends each active token and deactivates an FCM-unregistered token without exposing it in database writes", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false,status: 404,json: async () => ({ error: { status: "UNREGISTERED" } }) })
    .mockResolvedValueOnce({ ok: true,status: 200,json: async () => ({ name: "projects/project-test/messages/1" }) })
  vi.stubGlobal("fetch", fetchMock)
  const result = await sendFcmNotification({ tenantId: 7,userId: 11,destination: "user:11",title: "New message",body: "Customer: Hello",idempotencyKey: "notification:1",signal: new AbortController().signal,context: { eventType: "whatsapp_message",conversationId: "5" } })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(String(fetchMock.mock.calls[0][0])).toContain("/projects/project-test/messages:send")
  expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("SET enabled=0"), [1,7,11])
  expect(result).toEqual({ providerId: "fcm:1" })
})

it("deactivates all orphaned tokens and tolerates FCM being temporarily unavailable", async () => {
  mock.query.mockImplementation(async (sql: string) => sql.includes("SELECT id,token_encrypted") ? [{ id: 1,token_encrypted: "encrypted-1" }] : { affectedRows: 1 })
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false,status: 503,json: async () => ({ error: { status: "UNAVAILABLE" } }) }))
  await expect(sendFcmNotification({ tenantId: 7,userId: 11,destination: "user:11",title: "New message",body: "Hello",idempotencyKey: "n1",signal: new AbortController().signal })).rejects.toMatchObject({ code: "ECONNREFUSED" })
})
