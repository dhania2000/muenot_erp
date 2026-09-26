import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  query: vi.fn(),
  tableColumns: vi.fn(),
  requireTenant: vi.fn(),
  checker: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query, tableColumns: m.tableColumns, withTransaction: vi.fn() }))
vi.mock("@/lib/api-auth", () => ({ requireTenant: m.requireTenant }))
vi.mock("@/lib/permissions", () => ({ getFeatureChecker: m.checker }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLogFromRequest: m.audit }))

import {
  canOverrideAt,
  maskResolved,
  resolveInherited,
  validatePolicyValue,
  type OverrideLayer,
} from "@/lib/setting-inheritance/model"
import { getPolicyField, policyFieldsForDomain, POLICY_DOMAINS } from "@/lib/setting-inheritance/policies"
import { resolvePolicyDomain, setPolicyOverride, SettingInheritanceError } from "@/lib/setting-inheritance/store"
import { GET as policyGET, PUT as policyPUT } from "@/app/api/master-data/policies/[domain]/route"

const field = (key: string) => getPolicyField(key)!
const layer = (level: OverrideLayer["level"], value: string | null, scopeId = 1): OverrideLayer => ({ level, scopeId, value })

/**
 * SPEC 40 — configuration inheritance. The subsystem only earns trust if the
 * pure precedence rules are deterministic: a narrower scope overrides a broader
 * one, an override at a forbidden level never takes effect, secrets never leave
 * the server, and every write is tenant-scoped and governed.
 */

describe("precedence: user > department > branch > company > global > default", () => {
  const f = field("leave.min_notice_days") // overridable at every level

  it("falls back to the registry default when nothing is set", () => {
    const r = resolveInherited(f, [])
    expect(r.source).toBe("default")
    expect(r.value).toBe("3")
  })

  it("a global override beats the default", () => {
    const r = resolveInherited(f, [layer("global", "5", 0)])
    expect(r.source).toBe("global")
    expect(r.value).toBe("5")
  })

  it("the narrowest present scope wins over every broader one", () => {
    const r = resolveInherited(f, [
      layer("global", "5", 0),
      layer("company", "7"),
      layer("branch", "9"),
      layer("department", "11"),
      layer("user", "13"),
    ])
    expect(r.source).toBe("user")
    expect(r.value).toBe("13")
    // the winning layer is the only one flagged applied
    expect(r.trace.filter((t) => t.applied).map((t) => t.level)).toEqual(["user"])
  })

  it("skips scopes with a blank value and picks the next present one", () => {
    const r = resolveInherited(f, [layer("global", "5", 0), layer("branch", "  "), layer("company", "7")])
    expect(r.source).toBe("company")
    expect(r.value).toBe("7")
  })

  it("a deployment env override beats every stored scope", () => {
    const r = resolveInherited(f, [layer("user", "13")], { env: "1" })
    expect(r.source).toBe("env")
    expect(r.value).toBe("1")
    expect(r.trace.some((t) => t.applied)).toBe(false)
  })
})

describe("override legality (control policies cannot be relaxed)", () => {
  const security = field("security.mfa_required") // company/global only

  it("declares which levels may override", () => {
    expect(canOverrideAt(security, "company")).toBe(true)
    expect(canOverrideAt(security, "user")).toBe(false)
    expect(canOverrideAt(field("leave.min_notice_days"), "user")).toBe(true)
  })

  it("ignores a user-level override of a company-pinned policy", () => {
    const r = resolveInherited(security, [layer("company", "true"), layer("user", "false")])
    expect(r.value).toBe("true")
    expect(r.source).toBe("company")
    const userTrace = r.trace.find((t) => t.level === "user")!
    expect(userTrace.ignoredReason).toBe("not_overridable")
    expect(userTrace.applied).toBe(false)
  })
})

describe("value validation", () => {
  it("rejects non-numeric and negative numbers", () => {
    const f = field("expense.max_claim_amount")
    expect(validatePolicyValue(f, "abc").ok).toBe(false)
    expect(validatePolicyValue(f, "-1").ok).toBe(false)
    expect(validatePolicyValue(f, "1000")).toEqual({ ok: true, value: "1000" })
  })

  it("normalises toggles", () => {
    const f = field("security.mfa_required")
    expect(validatePolicyValue(f, "yes")).toEqual({ ok: true, value: "true" })
    expect(validatePolicyValue(f, "0")).toEqual({ ok: true, value: "false" })
    expect(validatePolicyValue(f, "maybe").ok).toBe(false)
  })
})

describe("secret masking", () => {
  it("never exposes a secret policy value", () => {
    const f = field("security.ip_allowlist")
    const r = resolveInherited(f, [layer("company", "10.0.0.0/8")])
    const masked = maskResolved(f, r)
    expect(masked.value).toBeNull()
    expect(masked.masked).toBe("••••••••")
    expect(JSON.stringify(masked.trace)).not.toContain("10.0.0.0")
  })
})

describe("catalogue integrity", () => {
  it("covers all four policy domains with fields", () => {
    for (const d of POLICY_DOMAINS) expect(policyFieldsForDomain(d).length).toBeGreaterThan(0)
  })
})

describe("store (tenant scope + governance + idempotency)", () => {
  const goodSchema = () => m.tableColumns.mockResolvedValue(new Set(["tenant_id", "policy_key", "scope_level", "scope_id", "svalue"]))
  const actor = { userId: 7, isAdmin: true, hasGovernanceGrant: true }

  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset()
  })

  it("fails closed when the migration is missing", async () => {
    m.tableColumns.mockResolvedValue(new Set(["tenant_id"]))
    await expect(resolvePolicyDomain(1, "expense", {})).rejects.toMatchObject({ code: "setup_required", status: 503 })
  })

  it("binds tenant id and only the context's scope ids when resolving", async () => {
    goodSchema()
    m.query.mockResolvedValue([])
    await resolvePolicyDomain(3, "leave", { companyId: 10, userId: 99 })
    const [sql, params] = m.query.mock.calls[0]
    expect(sql).toContain("tenant_id = ?")
    expect(params[0]).toBe(3)
    // global(0) + company(10) + user(99) scope pairs are bound; no other branch/user leaks
    expect(params).toContain(10)
    expect(params).toContain(99)
    expect(params).toContain(0)
  })

  it("rejects an override at a forbidden level before writing", async () => {
    goodSchema()
    m.query.mockResolvedValue([])
    await expect(
      setPolicyOverride(1, { key: "security.mfa_required", level: "user", scopeId: 5, value: "false" }, actor),
    ).rejects.toMatchObject({ code: "invalid", status: 400 })
    expect(m.query).not.toHaveBeenCalled()
  })

  it("blocks a governed change by a non-authorised actor", async () => {
    goodSchema()
    await expect(
      setPolicyOverride(
        1,
        { key: "security.mfa_required", level: "company", scopeId: 5, value: "true" },
        { userId: 7, isAdmin: false, hasGovernanceGrant: false },
      ),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 })
  })

  it("is idempotent: writing the same value again is a no-op", async () => {
    goodSchema()
    m.query.mockResolvedValue([{ svalue: "true" }])
    const res = await setPolicyOverride(1, { key: "security.mfa_required", level: "company", scopeId: 5, value: "true" }, actor)
    expect(res.action).toBe("unchanged")
    // only the SELECT ran, no INSERT
    expect(m.query).toHaveBeenCalledTimes(1)
  })

  it("upserts a changed value with tenant scope bound", async () => {
    goodSchema()
    m.query.mockImplementation(async (sql: string) => (sql.startsWith("SELECT") ? [{ svalue: "false" }] : { affectedRows: 1 }))
    const res = await setPolicyOverride(1, { key: "security.mfa_required", level: "company", scopeId: 5, value: "true" }, actor)
    expect(res.action).toBe("updated")
    const insert = m.query.mock.calls.find(([s]) => String(s).includes("INSERT"))!
    expect(insert[1][0]).toBe(1) // tenant id
    expect(insert[1]).toContain("true")
  })
})

describe("policies API", () => {
  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset()
    m.requireTenant.mockResolvedValue({ session: { userId: 7, role: "employee" }, tenantId: 1 })
    m.audit.mockResolvedValue(undefined)
    m.tableColumns.mockResolvedValue(new Set(["tenant_id", "policy_key", "scope_level", "scope_id", "svalue"]))
  })

  const req = (url = "http://x/api/master-data/policies/expense", init?: RequestInit) => new Request(url, init)
  const domain = (d: string) => ({ params: Promise.resolve({ domain: d }) })

  it("401s without a session", async () => {
    m.requireTenant.mockResolvedValue(null)
    expect((await policyGET(req(), domain("expense"))).status).toBe(401)
  })

  it("404s an unknown domain", async () => {
    m.checker.mockResolvedValue(() => true)
    expect((await policyGET(req("http://x/api/master-data/policies/nope"), domain("nope"))).status).toBe(404)
  })

  it("403s without the governance grant", async () => {
    m.checker.mockResolvedValue(() => false)
    expect((await policyGET(req(), domain("expense"))).status).toBe(403)
  })

  it("resolves a domain for the caller", async () => {
    m.checker.mockResolvedValue(() => true)
    m.query.mockResolvedValue([])
    const res = await policyGET(req(), domain("expense"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.domain).toBe("expense")
    expect(Array.isArray(body.entries)).toBe(true)
  })

  it("PUT audits an override and never logs the raw value", async () => {
    m.checker.mockResolvedValue(() => true)
    m.query.mockImplementation(async (sql: string) => (sql.startsWith("SELECT") ? [] : { affectedRows: 1 }))
    const res = await policyPUT(
      req("http://x/api/master-data/policies/security", {
        method: "PUT",
        body: JSON.stringify({ key: "security.ip_allowlist", level: "company", scopeId: 5, value: "10.0.0.0/8" }),
      }),
      domain("security"),
    )
    expect(res.status).toBe(200)
    const auditMeta = m.audit.mock.calls.at(-1)![1]
    expect(auditMeta.action).toBe("masterdata.policy.override")
    expect(JSON.stringify(auditMeta)).not.toContain("10.0.0.0")
  })

  it("propagates a store SettingInheritanceError as its status", async () => {
    m.checker.mockResolvedValue(() => true)
    const res = await policyPUT(
      req("http://x/api/master-data/policies/security", {
        method: "PUT",
        body: JSON.stringify({ key: "security.mfa_required", level: "user", scopeId: 5, value: "false" }),
      }),
      domain("security"),
    )
    expect(res.status).toBe(400)
    expect(SettingInheritanceError).toBeDefined()
  })
})
