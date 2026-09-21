import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ sql: vi.fn(), registration: vi.fn(), integration: vi.fn() }))
vi.mock("@/lib/db", () => ({ query: mock.sql }))
vi.mock("@/lib/tenant-scope", () => ({ currentTenantId: () => 7 }))
vi.mock("@/lib/token-crypto", () => ({ decryptToken: () => "private" }))
vi.mock("@/lib/whatsapp-config", () => ({ getWebhookUrl: () => "https://example.invalid/webhook" }))
vi.mock("@/lib/whatsapp-registration", () => ({ readMetaRegistration: mock.registration }))
vi.mock("@/lib/whatsapp", () => ({
  getWhatsAppIntegration: mock.integration,
  verifyWhatsAppCredentials: async () => ({ status: "CONNECTED", qualityRating: "GREEN" }),
  getWabaSubscriptionStatus: async () => ({ ok: true, subscribed: true, appNames: [] }),
  getWhatsAppTemplates: async () => ({ ok: true, templates: [] }),
  toPublicIntegration: () => ({ id: 4 }),
}))
import { getConnectionHealth } from "@/lib/whatsapp-health"
beforeEach(() => {
  vi.clearAllMocks(); mock.sql.mockResolvedValue([])
  mock.integration.mockResolvedValue({ id: 4, tenant_id: 7, phone_number_id: "200", access_token: "encrypted" })
  mock.registration.mockResolvedValue({ cloudApiRegistered: false, status: "pending" })
})
it("scopes webhook aggregate statistics to the request tenant", async () => {
  await getConnectionHealth()
  expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("WHERE tenant_id = ?"), [7])
})
it("distinguishes Meta connection from messaging readiness", async () => {
  const pending = await getConnectionHealth()
  expect(pending.connected).toBe(true)
  expect(pending.messagingReady).toBe(false)
  expect(pending.overall).toBe("degraded")
  mock.registration.mockResolvedValue({ cloudApiRegistered: true, status: "registered" })
  expect((await getConnectionHealth()).messagingReady).toBe(true)
})
