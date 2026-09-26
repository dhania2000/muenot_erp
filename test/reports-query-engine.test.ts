import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 33 (#70/#97) — Custom report builder + large exports · Phase 4.
 * ---------------------------------------------------------------------------
 * `lib/reports/query-builder.ts` is the ONLY place a client report definition
 * becomes SQL, and the ONLY place large exports are streamed. It is meant to be
 * safe by construction. These tests drive the real compiler/engine with the DB
 * and the authorization layer mocked, so we can capture the exact SQL + params
 * each run emits and prove the guarantees the spec calls out explicitly:
 *
 *   - SQL INJECTION — every value is parameterized, LIKE wildcards escaped, and
 *     no client string ever reaches an identifier position; unknown columns are
 *     rejected before any SQL runs.
 *   - MILLION-ROW PAGINATION — the export engine walks the primary key with a
 *     keyset cursor (`id > ?`) over a deterministic order, counts every row
 *     exactly once, and stops at the row cap.
 *   - CANCELLATION — a cooperative `shouldContinue` flag halts the walk between
 *     pages and reports the job cancelled.
 *   - CROSS-TENANT — a `tenant_id = ?` predicate is ALWAYS emitted, the run is
 *     REFUSED when no tenant discriminator exists, and an extra row-scope
 *     predicate is composed in.
 *   - FIELD PERMISSIONS — redactions from the security layer are surfaced and
 *     the offending field is gone from the rows.
 *   - FAILURE — unknown sources and undeployed tables fail closed.
 */

const h = vi.hoisted(() => ({
  dbColumns: new Set<string>(),
  calls: [] as { sql: string; params: any[] }[],
  responder: null as null | ((sql: string, params: any[], i: number) => any),
  scope: null as any,
  enforce: null as null | ((rows: any[]) => any),
}))

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    const i = h.calls.length
    h.calls.push({ sql, params })
    return h.responder ? h.responder(sql, params, i) : []
  }),
  tableColumns: vi.fn(async () => new Set(h.dbColumns)),
}))

// The authorization layer has its own dedicated data-leakage suite
// (reports-access-control.test.ts). Here we stub it to a pass-through so the
// engine's compile/paginate/scope behaviour can be isolated and asserted.
vi.mock("@/lib/reports/authorization", () => ({
  resolveReportActor: vi.fn(async (base: any) => ({
    ...base,
    subordinateUserIds: [],
    assignedEntities: [],
    assignedBranches: [],
    permissionGroups: [],
  })),
  buildReportScope: vi.fn(async () => h.scope),
  enforceReportSecurity: vi.fn(async (rows: any[]) =>
    h.enforce ? h.enforce(rows) : { rows, redactedFields: [], maskedFields: [] },
  ),
}))

import { runReport, runReportForExport, ReportValidationError, ROW_KEY } from "@/lib/reports/query-builder"

const INVOICE_COLS = [
  "id",
  "invoice_number",
  "client_id",
  "status",
  "currency",
  "subtotal",
  "tax_amount",
  "total",
  "amount_paid",
  "issue_date",
  "due_date",
  "created_at",
]

const fullSchema = () => new Set([...INVOICE_COLS, "tenant_id"])
const baseOpts = { tenantId: 7, role: "tenant_admin", userId: 1 } as any

function limitOf(sql: string): number {
  const m = sql.match(/LIMIT (\d+)/)
  return m ? Number(m[1]) : 0
}

beforeEach(() => {
  h.calls.length = 0
  h.dbColumns = fullSchema()
  h.responder = () => []
  h.scope = null
  h.enforce = null
})

// ---------------------------------------------------------------------------
// SQL injection
// ---------------------------------------------------------------------------
describe("SQL injection is impossible by construction", () => {
  it("parameterizes every value and escapes LIKE wildcards", async () => {
    await runReport(
      {
        sourceKey: "finance.invoices",
        columns: [{ column: "status" }],
        filters: [
          { column: "status", operator: "contains", value: "%_x' OR '1'='1" },
          { column: "total", operator: "eq", value: "1; DROP TABLE sales_invoices" },
        ],
      } as any,
      baseOpts,
    )

    const { sql, params } = h.calls[0]
    // Only backticked, allowlisted identifiers appear in the statement.
    expect(sql).toContain("FROM `sales_invoices`")
    expect(sql).toContain("`status` LIKE ?")
    expect(sql).toContain("`total` = ?")
    // The injected payloads are DATA, never SQL.
    expect(sql).not.toContain("DROP TABLE")
    expect(sql).not.toContain("OR '1'='1")
    expect(params).toContain("1; DROP TABLE sales_invoices")
    // `%` and `_` in the LIKE value are escaped so they match literally.
    expect(params.some((p) => typeof p === "string" && p.includes("\\%\\_x"))).toBe(true)
  })

  it("rejects a filter on a column outside the allowlist before running SQL", async () => {
    await expect(
      runReport(
        {
          sourceKey: "finance.invoices",
          columns: [{ column: "status" }],
          filters: [{ column: "secret; DROP TABLE x", operator: "eq", value: "x" }],
        } as any,
        baseOpts,
      ),
    ).rejects.toBeInstanceOf(ReportValidationError)
    expect(h.calls).toHaveLength(0)
  })

  it("parameterizes an IN list rather than interpolating it", async () => {
    await runReport(
      {
        sourceKey: "finance.invoices",
        columns: [{ column: "status" }],
        filters: [{ column: "status", operator: "in", value: "paid, void', overdue" }],
      } as any,
      baseOpts,
    )
    const { sql, params } = h.calls[0]
    expect(sql).toContain("`status` IN (?, ?, ?)")
    expect(params).toEqual(expect.arrayContaining(["paid", "void'", "overdue"]))
  })
})

// ---------------------------------------------------------------------------
// Million-row pagination
// ---------------------------------------------------------------------------
describe("million-row export pagination", () => {
  it("keyset-walks the primary key, counts each row once, and caps at maxRows", async () => {
    let nextId = 0
    h.responder = (sql) => {
      const limit = limitOf(sql)
      const rows: Record<string, unknown>[] = []
      for (let k = 0; k < limit; k++) {
        const id = ++nextId
        rows.push({ total: id, [ROW_KEY]: id })
      }
      return rows
    }

    const pageSizes: number[] = []
    const res = await runReportForExport(
      { sourceKey: "finance.invoices", columns: [{ column: "total" }] } as any,
      { ...baseOpts, maxRows: 1_000_000, pageSize: 50_000 },
      (page) => {
        pageSizes.push(page.rows.length)
      },
    )

    // Every one of a million rows accounted for, exactly once, then stopped.
    expect(res.totalRows).toBe(1_000_000)
    expect(res.truncated).toBe(true)
    expect(res.cancelled).toBe(false)
    expect(h.calls).toHaveLength(20)
    expect(pageSizes.reduce((a, b) => a + b, 0)).toBe(1_000_000)

    // Page 1 is a plain tenant-scoped read on a deterministic key order,
    // carrying a hidden cursor and NO offset re-scan.
    expect(h.calls[0].sql).toContain("`id` AS `__row_key`")
    expect(h.calls[0].sql).toContain("ORDER BY `id` ASC")
    expect(h.calls[0].sql).not.toContain("OFFSET")
    expect(h.calls[0].sql).not.toContain("`id` > ?")
    expect(h.calls[0].params).toEqual([7])

    // Page 2 resumes strictly after the last id of page 1 — the keyset cursor.
    expect(h.calls[1].sql).toContain("`id` > ?")
    expect(h.calls[1].params).toEqual([7, 50_000])
  })

  it("stops when the result set is exhausted before the cap", async () => {
    let nextId = 0
    let served = 0
    const TOTAL = 25
    h.responder = (sql) => {
      const limit = limitOf(sql)
      const n = Math.min(limit, TOTAL - served)
      const rows: Record<string, unknown>[] = []
      for (let k = 0; k < n; k++) {
        const id = ++nextId
        rows.push({ total: id, [ROW_KEY]: id })
      }
      served += n
      return rows
    }
    const res = await runReportForExport(
      { sourceKey: "finance.invoices", columns: [{ column: "total" }] } as any,
      { ...baseOpts, maxRows: 1_000_000, pageSize: 10 },
      () => {},
    )
    expect(res.totalRows).toBe(25)
    expect(res.truncated).toBe(false)
    expect(res.cancelled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------
describe("cooperative cancellation", () => {
  it("halts the walk between pages and reports cancelled", async () => {
    let nextId = 0
    h.responder = (sql) => {
      const limit = limitOf(sql)
      return Array.from({ length: limit }, () => {
        const id = ++nextId
        return { total: id, [ROW_KEY]: id }
      })
    }
    let checks = 0
    const res = await runReportForExport(
      { sourceKey: "finance.invoices", columns: [{ column: "total" }] } as any,
      {
        ...baseOpts,
        maxRows: 1_000_000,
        pageSize: 10,
        // Allow the first two pages, then request cancellation.
        shouldContinue: () => ++checks <= 2,
      },
      () => {},
    )
    expect(res.cancelled).toBe(true)
    expect(res.totalRows).toBe(20)
    expect(h.calls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Cross-tenant scope
// ---------------------------------------------------------------------------
describe("tenant scoping is mandatory", () => {
  it("always emits a tenant_id predicate bound to the context tenant", async () => {
    await runReport({ sourceKey: "finance.invoices", columns: [{ column: "total" }] } as any, baseOpts)
    expect(h.calls[0].sql).toContain("`tenant_id` = ?")
    expect(h.calls[0].params[0]).toBe(7)
  })

  it("refuses to run when the table has no tenant discriminator", async () => {
    h.dbColumns = new Set(INVOICE_COLS) // no tenant_id / company_id
    await expect(
      runReport({ sourceKey: "finance.invoices", columns: [{ column: "total" }] } as any, baseOpts),
    ).rejects.toThrow(/safely scoped/i)
  })

  it("composes the row-level scope predicate alongside the tenant predicate", async () => {
    h.scope = { sql: "`client_id` IN (?, ?)", params: [11, 22] }
    await runReport({ sourceKey: "finance.invoices", columns: [{ column: "total" }] } as any, baseOpts)
    expect(h.calls[0].sql).toContain("`client_id` IN (?, ?)")
    expect(h.calls[0].params).toEqual([7, 11, 22])
  })
})

// ---------------------------------------------------------------------------
// Field permissions
// ---------------------------------------------------------------------------
describe("field permissions", () => {
  it("surfaces redacted fields and removes them from the rows", async () => {
    h.responder = () => [{ status: "paid", total: 100 }]
    h.enforce = (rows) => ({
      rows: rows.map(({ total, ...rest }) => rest),
      redactedFields: ["total"],
      maskedFields: [],
    })
    const res = await runReport(
      { sourceKey: "finance.invoices", columns: [{ column: "status" }, { column: "total" }] } as any,
      baseOpts,
    )
    expect(res.redactedFields).toContain("total")
    expect(res.rows[0]).not.toHaveProperty("total")
    expect(res.rows[0]).toHaveProperty("status", "paid")
  })
})

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------
describe("failure paths fail closed", () => {
  it("rejects an unknown data source", async () => {
    await expect(
      runReport({ sourceKey: "nope.not_a_source", columns: [{ column: "x" }] } as any, baseOpts),
    ).rejects.toThrow(/Unknown data source/i)
  })

  it("rejects a source whose table is not deployed", async () => {
    h.dbColumns = new Set()
    await expect(
      runReport({ sourceKey: "finance.invoices", columns: [{ column: "total" }] } as any, baseOpts),
    ).rejects.toThrow(/not available/i)
  })
})
