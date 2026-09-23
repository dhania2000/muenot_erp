import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ tenant: vi.fn(), policies: vi.fn(), subject: vi.fn(), settings: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: mock.tenant }))
vi.mock("@/lib/abac-store", () => ({ listEnabledPolicies: mock.policies, resolveSubjectAttributes: mock.subject, getAbacSettings: mock.settings }))

import { evaluateAbac } from "@/lib/abac-enforce"
import type { SessionPayload } from "@/lib/auth"

const session = { userId: 42 } as SessionPayload

beforeEach(() => {
  vi.clearAllMocks()
  mock.tenant.mockReturnValue({ tenantId: 7 })
  mock.policies.mockResolvedValue([])
})

describe("ABAC fail-closed evaluation", () => {
  it("preserves RBAC-only behavior for tenants with no enabled policies", async () => {
    expect(await evaluateAbac(session, "sales", "view")).toMatchObject({ denied: false })
  })

  it("denies tenant access when policy storage is unavailable", async () => {
    mock.policies.mockRejectedValue(new Error("database unavailable"))
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    try { expect(await evaluateAbac(session, "sales", "view")).toMatchObject({ denied: true }) }
    finally { errorLog.mockRestore() }
  })

  it("keeps pre-auth/system calls outside a tenant context unchanged", async () => {
    mock.tenant.mockReturnValue(null)
    expect(await evaluateAbac(session, "sales", "view")).toMatchObject({ denied: false })
  })
})
