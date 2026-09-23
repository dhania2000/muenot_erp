import { afterEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ persist: vi.fn() }))
vi.mock("@/lib/system-monitoring", () => ({
  persistMonitorEvent: mock.persist,
  requestReference: (value: string | null) => value || "req_generated",
  safeDbError: () => ({ databaseErrorCode: "ER_DUP_ENTRY" }),
}))
import { onRequestError } from "@/instrumentation"

const originalRuntime = process.env.NEXT_RUNTIME
afterEach(() => { process.env.NEXT_RUNTIME = originalRuntime; vi.clearAllMocks() })

describe("global server failure capture", () => {
  it("captures route and reference without persisting the raw exception or authorization", async () => {
    process.env.NEXT_RUNTIME = "nodejs"
    mock.persist.mockResolvedValue(undefined)
    await onRequestError(new Error("Bearer private-token"), { path: "/api/orders?access_token=private-token", method: "POST", headers: { "x-request-id": "req_safe", authorization: "Bearer private-token" } }, { routeType: "route", routePath: "/api/orders", routerKind: "App Router" } as any)
    expect(mock.persist).toHaveBeenCalledOnce()
    const event = mock.persist.mock.calls[0][0]
    expect(event).toMatchObject({ service: "api", route: "/api/orders", method: "POST", requestId: "req_safe" })
    expect(JSON.stringify(event)).not.toContain("private-token")
  })
})
