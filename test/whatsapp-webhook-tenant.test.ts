import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ integration: vi.fn(), scope: vi.fn(), log: vi.fn(), contact: vi.fn(), conversation: vi.fn(), record: vi.fn(), context: vi.fn(), push: vi.fn() }))
vi.mock("@/lib/whatsapp", () => ({ getWhatsAppIntegrationByPhoneNumberId: mock.integration, getWebhookVerifyToken: () => "unused", verifyWebhookSignature: () => true }))
vi.mock("@/lib/tenant-scope", () => ({ runForTenant: mock.scope }))
vi.mock("@/lib/whatsapp-store", () => ({ logWebhookEvent: mock.log, findOrCreateContact: mock.contact, findOrCreateConversation: mock.conversation, recordInboundMessage: mock.record, getInboundContext: mock.context, normalizePhone: (phone: string) => phone }))
vi.mock("@/lib/whatsapp-push-notifications", () => ({ enqueueWhatsAppMessageNotifications: mock.push }))
vi.mock("@/lib/whatsapp-routing", () => ({ routeConversation: vi.fn() }))
vi.mock("@/lib/whatsapp-automations", () => ({ runInboundAutomations: vi.fn() }))
vi.mock("@/lib/whatsapp-campaigns", () => ({ applyCampaignStatusByWamid: vi.fn(), markCampaignReplied: vi.fn() }))
import { POST } from "@/app/api/marketing/whatsapp/webhook/route"
const request = () => new Request("https://erp.example/webhook", { method: "POST", headers: { "x-hub-signature-256": "test" }, body: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "100", changes: [{ field: "messages", value: { metadata: { phone_number_id: "200" } } }] }] }) })
beforeEach(() => {
  vi.clearAllMocks()
  mock.scope.mockImplementation(async (_, fn) => fn())
  mock.contact.mockResolvedValue({ id: 3,profile_name: "Customer" })
  mock.conversation.mockResolvedValue({ id: 5 })
  mock.record.mockResolvedValue(true)
  mock.context.mockResolvedValue({ isNewContact: false,isNewConversation: false,assignedAgentId: 12 })
})
const inboundRequest = () => new Request("https://erp.example/webhook", { method: "POST", headers: { "x-hub-signature-256": "test" }, body: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "100", changes: [{ field: "messages", value: { metadata: { phone_number_id: "200" }, messages: [{ id: "wamid.abc", from: "15551234567", timestamp: "1790000000", type: "text", text: { body: "Hello" } }] } }] }] }) })
it("resolves and scopes a signed webhook to the owning tenant", async () => {
  mock.integration.mockResolvedValue({ id: 4, tenant_id: 7, waba_id: "100", phone_number_id: "200" })
  expect((await POST(request())).status).toBe(200)
  expect(mock.integration).toHaveBeenCalledWith("200")
  expect(mock.scope).toHaveBeenCalledWith({ tenantId: 7 }, expect.any(Function))
})
it("does not process unknown or mismatched WABA deliveries under a tenant", async () => {
  mock.integration.mockResolvedValue(null)
  await POST(request())
  mock.integration.mockResolvedValue({ id: 4, tenant_id: 7, waba_id: "999", phone_number_id: "200" })
  await POST(request())
  expect(mock.scope).not.toHaveBeenCalled()
})

it("queues notifications only for newly persisted messages and treats push failures as best-effort", async () => {
  mock.integration.mockResolvedValue({ id: 4,tenant_id: 7,waba_id: "100",phone_number_id: "200" })
  mock.push.mockRejectedValue(new Error("FCM unavailable"))
  expect((await POST(inboundRequest())).status).toBe(200)
  expect(mock.push).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 7,wamid: "wamid.abc",conversationId: 5,assignedAgentId: 12 }))
  mock.record.mockResolvedValue(false) // Existing wamid: dedupe path.
  mock.push.mockClear()
  expect((await POST(inboundRequest())).status).toBe(200)
  expect(mock.push).not.toHaveBeenCalled()
})
