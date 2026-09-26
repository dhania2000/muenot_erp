import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  query: vi.fn(),
  tableColumns: vi.fn(),
  requireTenant: vi.fn(),
  checker: vi.fn(),
  audit: vi.fn(),
  enforce: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query, tableColumns: m.tableColumns }))
vi.mock("@/lib/api-auth", () => ({ requireTenant: m.requireTenant }))
vi.mock("@/lib/permissions", () => ({ getFeatureChecker: m.checker }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLogFromRequest: m.audit }))
vi.mock("@/lib/field-security", () => ({
  fieldSecurityActorFromSession: async () => ({ role: "member" }),
  enforceFieldSecurity: m.enforce,
}))

import {
  applyProfileMasks,
  decideAccess,
  normalizeIdentity,
  parsePartyId,
  parsePartyKind,
  parseSearchQuery,
  SECTIONS,
  usableLinks,
} from "@/lib/party-360/model"
import { findDuplicates, loadAnchorRow, loadSection } from "@/lib/party-360/store"
import { GET as detailGET } from "@/app/api/party-360/[kind]/[id]/route"
import { GET as listGET } from "@/app/api/party-360/[kind]/route"

type Schema = Record<string, string[]>
const schema = (s: Schema) => (t: string) => Promise.resolve(new Set(s[t] ?? []))

const EMP_COLS = ["id", "tenant_id", "employee_id", "employee_name", "mobile", "bank_account_number", "bank_pan_number", "personal_email", "user_id", "employment_status"]
const VENDOR_COLS = ["id", "tenant_id", "party_id", "customer_name", "party_type", "gstin", "pan", "bank_account_no", "official_email", "status"]

const req = (url = "http://x/api/party-360/employee/1") => new Request(url)
const detail = (kind: string, id: string) => detailGET(req(), { params: Promise.resolve({ kind, id }) })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.requireTenant.mockResolvedValue({ session: { userId: 7, role: "employee" }, tenantId: 1 })
  m.enforce.mockImplementation(async (rows: unknown[]) => ({ rows, applied: [] }))
  m.audit.mockResolvedValue(undefined)
})

describe("model validation", () => {
  it("parses kinds and ids strictly", () => {
    expect(parsePartyKind("vendor")).toBe("vendor")
    expect(parsePartyKind("candidate")).toBeNull()
    expect(parsePartyId("42")).toBe(42)
    for (const bad of ["0", "-1", "1e3", "01", "4.2", "99999999999", ""]) expect(parsePartyId(bad)).toBeNull()
    expect(parseSearchQuery("  acme\u0000 ")).toBe("acme")
    expect(parseSearchQuery("x".repeat(300))?.length).toBe(100)
  })

  it("masks sensitive fields per viewer and never returns internal linkage", () => {
    const row = { id: 1, employee_name: "A", bank_account_number: "123456789012", bank_pan_number: "ABCDE1234F", user_id: 7 }
    const hidden = applyProfileMasks("employee", row, () => false)
    expect(hidden.profile.bank_account_number).toBe("••••••••9012")
    expect(hidden.profile.bank_pan_number).toBe("XXXXXX234F")
    expect(hidden.profile).not.toHaveProperty("user_id")
    expect(hidden.masked.sort()).toEqual(["bank_account_number", "bank_pan_number"])
    const shown = applyProfileMasks("employee", row, (f) => f === "hr.manage_employees")
    expect(shown.profile.bank_account_number).toBe("123456789012")
    expect(shown.masked).toEqual([])
  })

  it("normalises identities for duplicate matching", () => {
    expect(normalizeIdentity("email", " A@B.COM ")).toBe("a@b.com")
    expect(normalizeIdentity("tax_id", "27abcde-1234f 1z5")).toBe("27ABCDE1234F1Z5")
    expect(normalizeIdentity("phone", "+91 98765-43210")).toBe("9876543210")
    expect(normalizeIdentity("domain", "https://www.acme.io/about")).toBe("acme.io")
    expect(normalizeIdentity("name", "Acme Pvt. Ltd.")).toBe(normalizeIdentity("name", "ACME private limited"))
  })

  it("drops name-based links when the child table is not tenant-scoped", () => {
    const links = SECTIONS.customer.find((s) => s.key === "leads")!.links
    expect(usableLinks(links, new Set(["company_name"]), false)).toEqual({ links: [], droppedUnscoped: true })
    expect(usableLinks(links, new Set(["company_name"]), true).links).toHaveLength(1)
  })

  it("grants self scope only to the record owner for employees", () => {
    expect(decideAccess("employee", false, { viewerUserId: 7, recordUserId: 7 })).toBe("self")
    expect(decideAccess("employee", false, { viewerUserId: 7, recordUserId: 8 })).toBeNull()
    expect(decideAccess("vendor", false, { viewerUserId: 7, recordUserId: 7 })).toBeNull()
    expect(decideAccess("customer", true, { viewerUserId: 7 })).toBe("full")
  })
})

describe("store", () => {
  it("fails closed when the anchor table has no tenant_id (migration not applied)", async () => {
    m.tableColumns.mockImplementation(schema({ hr_employees: ["id", "employee_name"] }))
    await expect(loadAnchorRow("employee", 1, 5)).rejects.toMatchObject({ code: "setup_required", status: 503 })
  })

  it("reports a missing anchor module as 404", async () => {
    m.tableColumns.mockImplementation(schema({}))
    await expect(loadAnchorRow("customer", 1, 5)).rejects.toMatchObject({ code: "module_unavailable", status: 404 })
  })

  it("always binds the tenant id and vendor filter on the anchor", async () => {
    m.tableColumns.mockImplementation(schema({ customers_vendors: VENDOR_COLS }))
    m.query.mockResolvedValue([])
    const { row } = await loadAnchorRow("vendor", 2, 9)
    expect(row).toBeNull()
    const [sql, params] = m.query.mock.calls[0]
    expect(sql).toContain("id = ? AND tenant_id = ?")
    expect(sql).toContain("party_type IN")
    expect(params).toEqual([9, 2])
  })

  const billSpec = SECTIONS.vendor.find((s) => s.key === "bills")!
  const values = { id: ["9"], code: ["CV-9"], name: ["Acme"], clientIds: [], financePartyIds: [] }

  it("degrades a missing child module to missing_module without querying", async () => {
    m.tableColumns.mockImplementation(schema({}))
    const res = await loadSection(billSpec, values, 1, true)
    expect(res.status).toBe("missing_module")
    expect(m.query).not.toHaveBeenCalled()
  })

  it("maps ER_NO_SUCH_TABLE mid-query to missing_module and other errors to a generic error", async () => {
    m.tableColumns.mockImplementation(schema({ purchase_bills: ["id", "vendor_id", "tenant_id"] }))
    m.query.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ER_NO_SUCH_TABLE" }))
    expect((await loadSection(billSpec, values, 1, true)).status).toBe("missing_module")
    m.query.mockRejectedValue(new Error("secret host 10.0.0.1 down"))
    const res = await loadSection(billSpec, values, 1, true)
    expect(res.status).toBe("error")
    expect(JSON.stringify(res)).not.toContain("10.0.0.1")
  })

  it("never queries a section the viewer cannot see", async () => {
    const res = await loadSection(billSpec, values, 1, false)
    expect(res.status).toBe("forbidden")
    expect(m.tableColumns).not.toHaveBeenCalled()
  })

  it("scopes a tenant-owned child by tenant and joins by the stable id", async () => {
    m.tableColumns.mockImplementation(schema({ purchase_bills: ["id", "vendor_id", "tenant_id", "po_number", "bill_date", "net_payable"] }))
    m.query.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT COUNT") ? [{ n: 1 }] : [{ id: 3, po_number: "PO-1", bill_date: "2027-01-02", net_payable: "100.5" }],
    )
    const res = await loadSection(billSpec, values, 4, true)
    expect(res).toMatchObject({ status: "ok", count: 1, items: [{ title: "PO-1", amount: 100.5, href: "/modules/finance/purchase-bills?bill=3" }] })
    for (const [sql, params] of m.query.mock.calls) {
      expect(sql).toContain("`vendor_id` IN (?)")
      expect(sql).toContain("tenant_id = ?")
      expect(params).toEqual(["9", 4])
    }
  })

  it("marks sections with only unscoped name links as unscoped", async () => {
    const leads = SECTIONS.customer.find((s) => s.key === "leads")!
    m.tableColumns.mockImplementation(schema({ sales_leads: ["id", "company_name"] }))
    expect((await loadSection(leads, values, 1, true)).status).toBe("unscoped")
    expect(m.query).not.toHaveBeenCalled()
  })

  it("finds same-tenant duplicates only after normalised comparison", async () => {
    m.tableColumns.mockImplementation(schema({ customers_vendors: VENDOR_COLS }))
    m.query.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(params[0]).toBe(3)
      if (sql.includes("LOWER(`gstin`)")) return [
        { id: 11, customer_name: "Acme Dup", gstin: "27abcde1234f1z5", party_id: "CV-11" },
        { id: 12, customer_name: "Near miss", gstin: "27ABCDE1234F1Z6", party_id: "CV-12" },
      ]
      if (sql.includes("LOWER(`official_email`)")) return [{ id: 11, customer_name: "Acme Dup", official_email: "AP@acme.io" }]
      return []
    })
    const ctx = { kind: "vendor" as const, tenantId: 3, cols: new Set(VENDOR_COLS) }
    const dups = await findDuplicates("vendor", ctx, { id: 10, gstin: "27ABCDE1234F1Z5", official_email: "ap@acme.io" })
    expect(dups).toEqual([{ id: 11, name: "Acme Dup", code: "CV-11", matchedOn: ["tax_id", "email"], href: "/modules/finance/vendor-360?id=11" }])
  })
})

describe("API", () => {
  const empRow = { id: 5, employee_id: "E-5", employee_name: "Asha", bank_account_number: "999988887777", user_id: 7, tenant_id: 1 }

  function employeeDb(row: Record<string, unknown> | null) {
    m.tableColumns.mockImplementation(schema({ hr_employees: EMP_COLS }))
    m.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM `hr_employees` WHERE id = ?")) return row && params[1] === row.tenant_id ? [row] : []
      return []
    })
  }

  it("401s without a tenant session", async () => {
    m.requireTenant.mockResolvedValue(null)
    expect((await detail("employee", "5")).status).toBe(401)
  })

  it("400s on invalid ids and 404s on unknown kinds", async () => {
    m.checker.mockResolvedValue(() => true)
    expect((await detail("employee", "abc")).status).toBe(400)
    expect((await detail("candidate", "1")).status).toBe(404)
  })

  it("403s vendor 360 without the base permission and audits the denial, without touching the DB", async () => {
    m.checker.mockResolvedValue(() => false)
    const res = await detail("vendor", "9")
    expect(res.status).toBe(403)
    expect(m.query).not.toHaveBeenCalled()
    expect(m.audit.mock.calls[0][1]).toMatchObject({ action: "party360.vendor.view", result: "denied" })
  })

  it("returns 404 for another tenant's record to a full-scope viewer", async () => {
    m.checker.mockResolvedValue(() => true)
    m.requireTenant.mockResolvedValue({ session: { userId: 1, role: "admin" }, tenantId: 2 })
    employeeDb(empRow)
    expect((await detail("employee", "5")).status).toBe(404)
  })

  it("lets an employee open only their own record, masked, with HR-owned sections", async () => {
    m.checker.mockResolvedValue(() => false)
    employeeDb(empRow)
    const res = await detail("employee", "5")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.scope).toBe("self")
    expect(body.profile.bank_account_number).toBe("••••••••7777")
    expect(body.profile).not.toHaveProperty("user_id")
    expect(body.duplicates).toEqual([])
    const statuses = Object.fromEntries(body.sections.map((s: { key: string; status: string }) => [s.key, s.status]))
    expect(statuses.activity).toBe("forbidden")
    expect(statuses.recruitment).toBe("forbidden")
    expect(m.audit.mock.calls.at(-1)[1]).toMatchObject({ action: "party360.employee.view", metadata: { scope: "self" } })
  })

  it("403s an employee opening someone else's record (no existence leak)", async () => {
    m.checker.mockResolvedValue(() => false)
    employeeDb({ ...empRow, user_id: 99 })
    const own = await detail("employee", "5")
    employeeDb(null)
    const missing = await detail("employee", "5")
    expect(own.status).toBe(403)
    expect(missing.status).toBe(403)
  })

  it("applies tenant field-security policies on top of baseline masks", async () => {
    m.checker.mockResolvedValue(() => true)
    employeeDb(empRow)
    m.enforce.mockImplementation(async (rows: Record<string, unknown>[]) => ({
      rows: rows.map((r) => ({ ...r, employee_id: "••••" })),
      applied: [{ field: "employee_id", effect: "masked" }],
    }))
    const body = await (await detail("employee", "5")).json()
    expect(body.profile.employee_id).toBe("••••")
    expect(body.maskedFields).toContain("employee_id")
    expect(body.profile.bank_account_number).toBe("999988887777")
  })

  it("list endpoint restricts self-scope employees to their own record", async () => {
    m.checker.mockResolvedValue(() => false)
    m.tableColumns.mockImplementation(schema({ hr_employees: EMP_COLS }))
    m.query.mockResolvedValue([])
    const res = await listGET(req("http://x/api/party-360/employee?q=a%25"), { params: Promise.resolve({ kind: "employee" }) })
    expect((await res.json()).scope).toBe("self")
    const [sql, params] = m.query.mock.calls[0]
    expect(sql).toContain("user_id = ?")
    expect(params).toEqual([1, 7, "%a\\%%", "%a\\%%"])
  })

  it("list endpoint surfaces setup_required when the migration is missing", async () => {
    m.checker.mockResolvedValue(() => true)
    m.tableColumns.mockImplementation(schema({ customers_vendors: ["id", "customer_name"] }))
    const res = await listGET(req("http://x/api/party-360/vendor"), { params: Promise.resolve({ kind: "vendor" }) })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("setup_required")
  })
})
