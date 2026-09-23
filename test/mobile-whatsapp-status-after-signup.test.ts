import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ integration: vi.fn(), health: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/whatsapp", () => ({ getWhatsAppIntegration: mock.integration, toPublicIntegration: (row: any) => row }))
vi.mock("@/lib/whatsapp-health", () => ({ getConnectionHealth: mock.health }))
vi.mock("@/lib/mobile-api", () => ({
  mobileJson: (body: unknown) => Response.json(body),
  isMobileResponse: (value: unknown) => value instanceof Response,
  withMobileAuth: (_request: Request, fn: (principal: object) => Promise<unknown>) => fn({ tenantId: 7 }),
}))
import { GET } from "@/app/api/mobile/v1/whatsapp/status/route"

beforeEach(() => { vi.clearAllMocks(); mock.integration.mockResolvedValue({ id: 4, businessName: "Shop", displayPhoneNumber: "+91123", connectedAt: "2026-09-23" }) })
it("immediately reports the persisted tenant connection even if Meta health is still pending", async () => {
  mock.health.mockResolvedValue({ messagingReady: false, checks: [{ id: "subscription", status: "warn" }], phone: null })
  const response = await GET(new Request("https://erp.example.test/api/mobile/v1/whatsapp/status"))
  expect(await response.json()).toMatchObject({ connected: true, status: "ACTION_REQUIRED", messagingReady: false, webhookSubscribed: false })
})
it("still reports linked after a transient Meta health probe failure", async () => {
  mock.health.mockRejectedValue(new Error("Meta timeout"))
  const response = await GET(new Request("https://erp.example.test/api/mobile/v1/whatsapp/status"))
  expect(await response.json()).toMatchObject({ connected: true, status: "ACTION_REQUIRED" })
})
it("reports disconnected only if no tenant connection was persisted", async () => {
  mock.integration.mockResolvedValue(null)
  const response = await GET(new Request("https://erp.example.test/api/mobile/v1/whatsapp/status"))
  expect(await response.json()).toMatchObject({ connected: false, status: "NOT_CONNECTED" })
})
