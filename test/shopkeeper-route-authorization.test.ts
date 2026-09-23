import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ staff: vi.fn(), superAdmin: vi.fn(), approve: vi.fn(), register: vi.fn(), rate: vi.fn(), mobileGuard: vi.fn(), onboarding: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/platform-guard", () => ({ requirePlatformStaff: mock.staff, requirePlatformSuperAdmin: mock.superAdmin }))
vi.mock("@/lib/shopkeeper-applications", () => ({
  ApplicationError: class ApplicationError extends Error { status = 400 },
  registerShopkeeper: mock.register, approveApplication: mock.approve,
  listApplications: vi.fn(), getApplication: vi.fn(), rejectApplication: vi.fn(), reopenApplication: vi.fn(),
}))
vi.mock("@/lib/mobile-whatsapp-onboarding", () => ({ MobileOnboardingError: class MobileOnboardingError extends Error { status = 403 }, createMobileOnboarding: mock.onboarding }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mock.rate, getClientIp: () => "127.0.0.1" }))
vi.mock("@/lib/mobile-api", () => ({ mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init), withMobileAuth: mock.mobileGuard, isMobileResponse: (value: unknown) => value instanceof Response }))
import { POST as register } from "@/app/api/mobile/v1/auth/register/route"
import { POST as approval } from "@/app/api/platform/shopkeepers/applications/[id]/route"
import { POST as onboarding } from "@/app/api/mobile/v1/whatsapp/onboarding-session/route"

beforeEach(() => {
  vi.clearAllMocks()
  mock.rate.mockReturnValue({ allowed: true })
  mock.staff.mockResolvedValue({ ok: false, status: 401, reason: "Unauthorized" })
  mock.superAdmin.mockResolvedValue({ ok: false, status: 403, reason: "Forbidden" })
  mock.mobileGuard.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }))
})
it("blocks anonymous or tenant-admin approval before reading any application", async () => {
  const response = await approval(new Request("https://example.test/api/platform/shopkeepers/applications/1", { method: "POST", body: JSON.stringify({ action: "approve", planCode: "shopkeeper" }) }), { params: Promise.resolve({ id: "1" }) })
  expect(response.status).toBe(403)
  expect(mock.approve).not.toHaveBeenCalled()
})
it("blocks anonymous mobile WhatsApp onboarding before the service is invoked", async () => {
  const response = await onboarding(new Request("https://example.test/api/mobile/v1/whatsapp/onboarding-session", { method: "POST" }))
  expect(response.status).toBe(401)
  expect(mock.onboarding).not.toHaveBeenCalled()
})
it("rate limits public registration", async () => {
  mock.rate.mockReturnValue({ allowed: false, retryAfter: 60 })
  const response = await register(new Request("https://example.test/api/mobile/v1/auth/register", { method: "POST", body: "{}" }))
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBe("60")
  expect(mock.register).not.toHaveBeenCalled()
})
