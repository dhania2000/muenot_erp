import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ integration: vi.fn(), scope: vi.fn(), log: vi.fn() }))
vi.mock("@/lib/whatsapp", () => ({ getWhatsAppIntegrationByPhoneNumberId: mock.integration, getWebhookVerifyToken: () => "unused", verifyWebhookSignature: () => true }))
vi.mock("@/lib/tenant-scope", () => ({ runForTenant: mock.scope }))
vi.mock("@/lib/whatsapp-store", () => ({ logWebhookEvent: mock.log }))
vi.mock("@/lib/whatsapp-routing", () => ({ routeConversation: vi.fn() }))
vi.mock("@/lib/whatsapp-automations", () => ({ runInboundAutomations: vi.fn() }))
vi.mock("@/lib/whatsapp-campaigns", () => ({ applyCampaignStatusByWamid: vi.fn(), markCampaignReplied: vi.fn() }))
import { POST } from "@/app/api/marketing/whatsapp/webhook/route"
const request = () => new Request("https://erp.example/webhook", { method: "POST", headers: { "x-hub-signature-256": "test" }, body: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "100", changes: [{ field: "messages", value: { metadata: { phone_number_id: "200" } } }] }] }) })
beforeEach(() => { vi.clearAllMocks(); mock.scope.mockImplementation(async (_, fn) => fn()) })
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
