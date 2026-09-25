import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 20 (req #75) — tenant isolation of the anomaly collectors.
 * The global ERP ledger (payments, sales_invoices) has no tenant_id, so it
 * must only feed the platform-owner tenant; tenant-owned billing tables must
 * always carry the current tenant predicate.
 */

const m = vi.hoisted(() => ({
  query: vi.fn(),
  tenantId: 7 as number | null,
  listPayments: vi.fn(),
  listSecurityEvents: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query }))
vi.mock("@/lib/tenant-scope", () => ({
  currentTenantIdOrNull: () => m.tenantId,
  scopedWhere: (_t: string, extra: string, params: any[]) => ({
    where: `WHERE \`tenant_id\` = ? AND (${extra})`,
    params: [m.tenantId, ...params],
  }),
}))
vi.mock("@/lib/finance-payments", () => ({ listPayments: m.listPayments }))
vi.mock("@/lib/security-audit-store", () => ({ listSecurityEvents: m.listSecurityEvents }))

import { collectObservations, ownsGlobalErpLedger } from "@/lib/ai/anomaly-detection/collectors"

const NOW = new Date("2027-01-20T12:00:00Z")

function routeQueries(isOwner: boolean) {
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM `tenants`")) return [{ is_platform_owner: isOwner ? 1 : 0 }]
    if (sql.includes("billing_payments")) return [{ id: 1, payment_no: "BP-1", amount: 100, method: "card", paid_on: "2027-01-19" }]
    if (sql.includes("billing_invoices")) return [{ id: 2, invoice_no: "BI-1", issue_date: "2027-01-19", total: 50, customer_name: "Acme" }]
    if (sql.includes("sales_invoices")) return [{ invoice_id: "SI-1", invoice_date: "2027-01-19", net_receivable: 999, party_name: "Other org" }]
    return []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  m.tenantId = 7
  m.listPayments.mockResolvedValue([{ payment_id: "P-1", amount: 5000, payment_date: "2027-01-19", status: "posted" }])
  m.listSecurityEvents.mockResolvedValue([])
})

describe("collectObservations — tenant isolation", () => {
  it("never reads the global ERP ledger for a non-owner tenant", async () => {
    routeQueries(false)
    const data = await collectObservations({ windowDays: 30, categories: ["payment", "invoice"], now: NOW })
    expect(m.listPayments).not.toHaveBeenCalled()
    expect(m.query.mock.calls.some(([sql]) => String(sql).includes("sales_invoices"))).toBe(false)
    expect(data.payments.map((p) => p.id)).toEqual(["billing:BP-1"])
    expect(data.invoices.map((i) => i.id)).toEqual(["billing:BI-1"])
  })

  it("scopes billing reads to the current tenant id", async () => {
    routeQueries(false)
    await collectObservations({ windowDays: 30, categories: ["payment", "invoice"], now: NOW })
    const billing = m.query.mock.calls.filter(([sql]) => /billing_(payments|invoices)/.test(String(sql)))
    expect(billing).toHaveLength(2)
    for (const [sql, params] of billing) {
      expect(String(sql)).toContain("`tenant_id` = ?")
      expect(params[0]).toBe(7)
    }
  })

  it("includes the ERP ledger for the platform-owner tenant", async () => {
    routeQueries(true)
    const data = await collectObservations({ windowDays: 30, categories: ["payment", "invoice"], now: NOW })
    expect(m.listPayments).toHaveBeenCalledOnce()
    expect(data.payments.map((p) => p.id).sort()).toEqual(["P-1", "billing:BP-1"])
    expect(data.invoices.map((i) => i.id).sort()).toEqual(["SI-1", "billing:BI-1"])
  })

  it("passes the tenant id to the security audit reader", async () => {
    routeQueries(false)
    await collectObservations({ windowDays: 30, categories: ["access"], now: NOW })
    expect(m.listSecurityEvents).toHaveBeenCalled()
    for (const [tenant] of m.listSecurityEvents.mock.calls) expect(tenant).toBe(7)
  })

  it("survives a failing source without aborting the scan", async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM `tenants`")) return [{ is_platform_owner: 0 }]
      throw new Error("table missing")
    })
    const data = await collectObservations({ windowDays: 7, now: NOW })
    expect(data.payments).toEqual([])
    expect(data.invoices).toEqual([])
    expect(data.usage).toEqual([])
  })
})

describe("ownsGlobalErpLedger — fails closed", () => {
  it("is false with no tenant", async () => {
    expect(await ownsGlobalErpLedger(null)).toBe(false)
    expect(m.query).not.toHaveBeenCalled()
  })
  it("is false when the lookup errors", async () => {
    m.query.mockRejectedValue(new Error("down"))
    expect(await ownsGlobalErpLedger(3)).toBe(false)
  })
  it("is false for an unknown tenant", async () => {
    m.query.mockResolvedValue([])
    expect(await ownsGlobalErpLedger(3)).toBe(false)
  })
})
