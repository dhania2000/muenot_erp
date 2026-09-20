import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ guard: vi.fn(), retry: vi.fn() }))
vi.mock("@/lib/platform-guard", () => ({ requirePlatformSuperAdmin: mocks.guard }))
vi.mock("@/lib/job-manual-retry", () => ({ retryDeadLetter: mocks.retry, RetryConflict: class extends Error {} }))
import { POST } from "@/app/api/platform/background-jobs/[id]/retry/route"
const ctx = { params: Promise.resolve({ id: "12" }) }
beforeEach(() => vi.resetAllMocks())
it("rejects tenant/staff callers without changing jobs", async () => {
  mocks.guard.mockResolvedValue({ ok: false, status: 403, reason: "Forbidden" })
  expect((await POST(new Request("http://localhost", { method: "POST" }), ctx)).status).toBe(403)
  expect(mocks.retry).not.toHaveBeenCalled()
})
it("validates the expected attempt", async () => {
  mocks.guard.mockResolvedValue({ ok: true, session: { userId: 99 } })
  expect((await POST(new Request("http://localhost", { method: "POST", body: "{}" }), ctx)).status).toBe(400)
  expect(mocks.retry).not.toHaveBeenCalled()
})
it("takes the audit actor from the verified session", async () => {
  mocks.guard.mockResolvedValue({ ok: true, session: { userId: 99 } })
  mocks.retry.mockResolvedValue({ id: 12, status: "queued" })
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ attempt: 3, actorId: 1, acknowledgeUncertain: true }) }), ctx)
  expect(response.status).toBe(200)
  expect(mocks.retry).toHaveBeenCalledWith(12, 3, 99, true)
})
