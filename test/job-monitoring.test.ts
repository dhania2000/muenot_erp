import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  query: vi.fn(), cron: vi.fn(), queue: vi.fn(),
  platform: vi.fn(), tenant: vi.fn(), effectiveTenant: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ query: mocks.query }))
vi.mock("@/lib/background-jobs", () => ({ ensureBackgroundJobSchema: mocks.queue }))
vi.mock("@/lib/cron-jobs", () => ({ ensureCronJobSchema: mocks.cron }))
vi.mock("@/lib/platform-guard", () => ({
  requirePlatformSuperAdmin: mocks.platform, requireTenantAdmin: mocks.tenant,
  effectiveTenantId: mocks.effectiveTenant,
}))
import { readJobMonitor, observeJob, safeJobError } from "@/lib/job-monitoring"
import { jobMonitorResponse } from "@/lib/job-monitoring-api"
import { backgroundJobView } from "@/lib/background-job-view"

beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue([])
  mocks.queue.mockResolvedValue(undefined)
  mocks.cron.mockResolvedValue(undefined)
})

describe("SPEC 43 monitoring isolation", () => {
  it("scopes list, counts and alerts to the verified tenant, excluding cron", async () => {
    mocks.tenant.mockResolvedValue({ ok: true, ctx: {} })
    mocks.effectiveTenant.mockReturnValue(42)
    const response = await jobMonitorResponse(new Request("http://localhost/api/admin/job-monitoring?tenant_id=99"), "tenant")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(mocks.query).toHaveBeenCalledTimes(3)
    for (const [sql, params] of mocks.query.mock.calls) {
      expect(sql).toContain("WHERE tenant_id=?")
      expect(sql).not.toContain("platform_cron_runs")
      expect(sql).not.toMatch(/\b(payload|idempotency_key|result)\b/)
      expect(params).toEqual([42])
    }
    expect(mocks.cron).not.toHaveBeenCalled()
  })
  it("rejects unauthorized requests before loading jobs", async () => {
    mocks.platform.mockResolvedValue({ ok: false, status: 403, reason: "Forbidden" })
    const response = await jobMonitorResponse(new Request("http://localhost/api/platform/job-monitoring"), "platform")
    expect(response.status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it("fails closed for missing tenants and invalid pages", async () => {
    mocks.tenant.mockResolvedValue({ ok: true, ctx: {} })
    mocks.effectiveTenant.mockReturnValue(null)
    expect((await jobMonitorResponse(new Request("http://localhost/"), "tenant")).status).toBe(403)
    await expect(readJobMonitor({ kind: "tenant", tenantId: 0 })).rejects.toThrow()
    await expect(readJobMonitor({ kind: "platform" }, NaN)).rejects.toThrow()
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it("combines platform jobs and computes totals independent of page size", async () => {
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { status: "succeeded", total: 100, retried: 3 },
      { status: "completed", total: 7, retried: 1 },
      { status: "dead_letter", total: 2, retried: 2 },
    ]).mockResolvedValueOnce([])
    const result = await readJobMonitor({ kind: "platform" }, 2)
    expect(result.total).toBe(109)
    expect(result.summary).toMatchObject({ completed: 107, failed: 2, retried: 6 })
    expect(mocks.query.mock.calls[0][0]).toContain("UNION ALL")
    expect(mocks.query.mock.calls[0][0]).toContain("OFFSET 50")
    expect(mocks.query.mock.calls[2][0]).toContain("overdue=1")
    expect(mocks.query.mock.calls[2][0]).not.toContain("OFFSET")
  })
  it("normalizes failure, retries, duration and redacts arbitrary errors", () => {
    const job = observeJob({
      id: 8, kind: "background", name: "email.send", tenant_id: 42,
      status: "dead_letter", attempts: 3, duration_ms: 1900, trigger_source: "scheduler",
      error_message: "failed token=SECRET /reset-password?token=SECRET", created_at: "2026-09-20", overdue: 0,
    })
    expect(job).toMatchObject({ status: "failed", deadLetter: true, retries: 2, durationMs: 1900, triggerSource: "scheduler" })
    expect(JSON.stringify(job)).not.toContain("SECRET")
    expect(safeJobError("ETIMEDOUT token=SECRET")).toBe("Execution timed out.")
    expect(safeJobError("Job endpoint returned HTTP 503")).toBe("Service returned HTTP 503.")
  })
  it("does not leak secrets through the legacy queue console", () => {
    const view = backgroundJobView({ id: 1, payload: { html: "SECRET" }, idempotency_key: "SECRET", result: { token: "SECRET" }, error_message: "SECRET" } as any)
    expect(JSON.stringify(view)).not.toContain("SECRET")
    expect(view).not.toHaveProperty("payload")
    expect(view).not.toHaveProperty("idempotency_key")
  })
})
