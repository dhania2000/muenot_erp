import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ guard: vi.fn(), finalize: vi.fn() }))
vi.mock("@/lib/platform-guard", () => ({ requireTenantAdmin: mock.guard, effectiveTenantId: () => 7 }))
vi.mock("@/lib/whatsapp-registration", () => ({ finalizeWhatsAppRegistration: mock.finalize }))
import { POST } from "@/app/api/marketing/whatsapp/registration/route"
const request = (body: unknown, origin = "https://erp.example") => new Request("https://erp.example/api/marketing/whatsapp/registration", { method: "POST", headers: { origin }, body: JSON.stringify(body) })
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("APP_URL", "https://erp.example"); mock.guard.mockResolvedValue({ ok: true, ctx: {} }); mock.finalize.mockResolvedValue({ cloudApiRegistered: true }) })
it("uses verified tenant and stored connection, not supplied tenant/token/phone", async () => {
  expect((await POST(request({ connectionId: 4, tenantId: 99, accessToken: "ignored", phoneNumberId: "ignored" }))).status).toBe(200)
  expect(mock.finalize).toHaveBeenCalledWith(7, 4, undefined)
})
it("rejects non-admin and cross-origin requests", async () => {
  expect((await POST(request({ connectionId: 4 }, "https://attacker.example"))).status).toBe(403)
  mock.guard.mockResolvedValue({ ok: false, status: 403, reason: "Forbidden" })
  expect((await POST(request({ connectionId: 4 }))).status).toBe(403)
  expect(mock.finalize).not.toHaveBeenCalled()
})
it("rejects malformed PIN and hides internal error details", async () => {
  expect((await POST(request({ connectionId: 4, pin: 123456 }))).status).toBe(400)
  mock.finalize.mockRejectedValue(new Error("private token"))
  const response = await POST(request({ connectionId: 4 }))
  expect(response.status).toBe(409)
  expect(JSON.stringify(await response.json())).not.toContain("private")
})
