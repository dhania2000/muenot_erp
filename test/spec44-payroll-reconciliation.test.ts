import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  query: vi.fn(),
  tableColumns: vi.fn(),
  getCurrentTenant: vi.fn(),
  audit: vi.fn(),
  session: vi.fn(),
  can: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query, tableColumns: m.tableColumns }))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: m.getCurrentTenant }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: m.audit }))
vi.mock("@/lib/operations-resource-management", () => ({ normaliseToHourly: (r: unknown) => Number(r) || 0 }))
vi.mock("@/lib/auth", () => ({ getSession: m.session }))
vi.mock("@/lib/permission-enforce", () => ({ canPerformAction: m.can }))

import { annualTax, monthlyWithholding, reconcilePayroll, validateTaxSlabs } from "@/lib/payroll-reconciliation-core"
import { createPayrollRun, finalizePayrollRun } from "@/lib/payroll-reconciliation"
import { GET, POST } from "@/app/api/hr/payroll/route"

const rate = () => 100

describe("reconcilePayroll (pure)", () => {
  it("pays min(attendance, timesheet) and splits daily overtime", () => {
    const { lines } = reconcilePayroll(
      [
        { employee_id: "1", employee_name: "Asha", work_date: "2026-05-04", working_hours: 10, status: "Present" },
        { employee_id: "1", work_date: "2026-05-05", working_hours: 8, status: "Present" },
      ],
      [
        { employee_id: "1", work_date: "2026-05-04", hours: 10 },
        { employee_id: "1", work_date: "2026-05-05", hours: 8 },
      ],
      { period: "2026-05", rateOf: rate },
    )
    expect(lines[0]).toMatchObject({ regularHours: 16, overtimeHours: 2, gross: 1900, reconciled: true })
  })

  it("flags mismatches and one-sided days, never paying unverified hours", () => {
    const { lines, summary } = reconcilePayroll(
      [
        { employee_id: "1", work_date: "2026-05-04", working_hours: 8, status: "Present" },
        { employee_id: "1", work_date: "2026-05-06", working_hours: 8, status: "Present" },
      ],
      [
        { employee_id: "1", work_date: "2026-05-04", hours: 6 },
        { employee_id: "1", work_date: "2026-05-05", hours: 8 },
      ],
      { period: "2026-05", rateOf: rate },
    )
    expect(lines[0].issues.map((i) => i.flag)).toEqual([
      "hours_mismatch",
      "timesheet_without_attendance",
      "attendance_without_timesheet",
    ])
    expect(lines[0].payableHours).toBe(6)
    expect(summary.unreconciledCount).toBe(1)
  })

  it("excludes cross-period rows and pays paid absences a standard day", () => {
    const { lines } = reconcilePayroll(
      [
        { employee_id: "1", work_date: "2026-04-30", working_hours: 8, status: "Present" },
        { employee_id: "1", work_date: "2026-05-01", working_hours: 0, status: "Leave" },
      ],
      [{ employee_id: "1", work_date: "2026-06-01", hours: 8 }],
      { period: "2026-05", rateOf: rate },
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ paidAbsenceDays: 1, regularHours: 8, attendanceHours: 0, timesheetHours: 0 })
  })

  it("rejects a malformed period", () => {
    expect(() => reconcilePayroll([], [], { period: "2026-13", rateOf: rate })).toThrow(/YYYY-MM/)
  })
})

describe("tax", () => {
  it("applies progressive slabs", () => {
    expect(annualTax(400000)).toBe(0)
    expect(annualTax(1000000)).toBe(40000) // 5% of 4L + 10% of 2L
    expect(monthlyWithholding(100000)).toBe(round(annualTax(1200000) / 12))
  })
  it("validates custom slabs", () => {
    expect(() => validateTaxSlabs([{ upTo: 100, rate: 5 }, { upTo: 50, rate: 10 }])).toThrow(/increasing/)
    expect(() => validateTaxSlabs([{ upTo: null, rate: 5 }, { upTo: 50, rate: 10 }])).toThrow(/final/)
    expect(() => validateTaxSlabs([{ upTo: null, rate: 150 }])).toThrow(/rate/)
  })
})
const round = (n: number) => Math.round(n * 100) / 100

describe("payroll runs (service)", () => {
  let runs: any[]
  beforeEach(() => {
    vi.clearAllMocks()
    runs = []
    m.getCurrentTenant.mockReturnValue({ tenantId: 7 })
    m.tableColumns.mockResolvedValue(new Set())
    m.query.mockImplementation(async (sql: string, p: any[] = []) => {
      if (sql.startsWith("CREATE TABLE")) return []
      if (/FROM hr_attendance/.test(sql)) return [{ employee_id: 1, work_date: "2026-05-04", working_hours: 8, status: "Present" }]
      if (/idempotency_key = \?/.test(sql)) return runs.filter((r) => r.tenant_id === p[0] && r.idempotency_key === p[1])
      if (/status = 'Finalized' AND id <>/.test(sql)) return runs.filter((r) => r.tenant_id === p[0] && r.period === p[1] && r.status === "Finalized" && r.id !== p[2])
      if (/status = 'Finalized' LIMIT/.test(sql)) return runs.filter((r) => r.tenant_id === p[0] && r.period === p[1] && r.status === "Finalized")
      if (sql.startsWith("INSERT INTO hr_payroll_runs")) {
        const id = runs.length + 1
        runs.push({ id, tenant_id: p[0], period: p[1], status: "Draft", idempotency_key: p[2], unreconciled_count: p[7], lines: p[9] })
        return { insertId: id }
      }
      if (/WHERE id = \? AND \(tenant_id <=> \?\)/.test(sql)) return runs.filter((r) => r.id === p[0] && r.tenant_id === p[1])
      if (sql.startsWith("UPDATE hr_payroll_runs")) {
        const r = runs.find((x) => x.id === p[1])
        if (r) r.status = "Finalized"
        return { affectedRows: 1 }
      }
      return []
    })
  })

  it("is idempotent per key", async () => {
    const a = await createPayrollRun({ period: "2026-05", idempotency_key: "k" }, { userId: 1 })
    const b = await createPayrollRun({ period: "2026-05", idempotency_key: "k" }, { userId: 1 })
    expect(b.duplicate).toBe(true)
    expect(b.run.id).toBe(a.run.id)
    expect(runs).toHaveLength(1)
  })

  it("blocks finalizing unreconciled runs without a reason, then locks the period", async () => {
    const { run } = await createPayrollRun({ period: "2026-05" }, { userId: 1 })
    expect(run.unreconciled_count).toBe(1) // attendance without timesheet
    await expect(finalizePayrollRun(run.id, { userId: 2 })).rejects.toThrow(/unreconciled/)
    const done = await finalizePayrollRun(run.id, { userId: 2 }, { force: true, reason: "Manager confirmed" })
    expect(done.status).toBe("Finalized")
    await expect(createPayrollRun({ period: "2026-05" }, { userId: 1 })).rejects.toThrow(/already finalized/)
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll_run.finalize" }))
  })

  it("cannot read or finalize another tenant's run", async () => {
    const { run } = await createPayrollRun({ period: "2026-05" }, { userId: 1 })
    m.getCurrentTenant.mockReturnValue({ tenantId: 8 })
    await expect(finalizePayrollRun(run.id, { userId: 2 }, { force: true, reason: "x" })).rejects.toThrow(/not found/)
  })
})

describe("payroll route", () => {
  const req = (url: string, body?: unknown) =>
    Object.assign(new Request(url, body ? { method: "POST", body: JSON.stringify(body) } : undefined), {
      nextUrl: new URL(url),
    }) as any

  beforeEach(() => {
    m.session.mockResolvedValue({ userId: 1, role: "user" })
    m.can.mockResolvedValue(true)
  })

  it("401 without a session, 403 without permission", async () => {
    m.session.mockResolvedValueOnce(null)
    expect((await GET(req("http://x/api/hr/payroll"))).status).toBe(401)
    m.can.mockResolvedValueOnce(false)
    expect((await POST(req("http://x/api/hr/payroll", { action: "create", period: "2026-05" }))).status).toBe(403)
  })

  it("400 on invalid period / action", async () => {
    expect((await POST(req("http://x/api/hr/payroll", { action: "create", period: "May" }))).status).toBe(400)
    expect((await POST(req("http://x/api/hr/payroll", { action: "nope" }))).status).toBe(400)
    expect((await GET(req("http://x/api/hr/payroll?preview=1&period=bad"))).status).toBe(400)
  })
})
