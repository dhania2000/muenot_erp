import { describe, expect, it } from "vitest"
import { TENANT_OWNED_TABLES } from "@/lib/tenant-tables"
import {
  DEFAULT_TTL_DAYS,
  DEMO_CLIENT_SEED,
  DEMO_CLONE_DENYLIST,
  DEMO_CLONE_TABLES,
  DEMO_TEMPLATE_SLUG,
  MAX_TTL_DAYS,
  assertDemoTablesSafe,
  buildClonedRow,
  clampTtlDays,
  computeExpiresAt,
  demoDaysRemaining,
  demoPurgeTables,
  extendExpiry,
  isDemoCloneDenied,
  isDemoCloneTenantRecord,
  isDemoExpired,
  normalizeCloneInput,
  parseDemoTime,
  parseExtendDays,
  regenerateUniqueValue,
  scopeIdempotencyKey,
  toSqlDatetime,
} from "@/lib/demo-tenant-model"

const DAY = 86_400_000
const now = new Date("2027-02-01T00:00:00Z")

describe("never-clone safety", () => {
  it("allowlist and denylist never overlap and every allowlisted table is tenant-owned", () => {
    expect(() => assertDemoTablesSafe()).not.toThrow()
    for (const { table } of DEMO_CLONE_TABLES) expect(isDemoCloneDenied(table)).toBe(false)
  })

  it("denies every tenant-owned table whose name marks secrets, integrations, payments or sessions", () => {
    const sensitive = /secret|credential|token|password|billing|payment|bank|session|api_key|webhook|sso|oauth|whatsapp|connector|integration|gateway|subscription/
    const leaked = TENANT_OWNED_TABLES.filter((t) => sensitive.test(t) && !isDemoCloneDenied(t))
    expect(leaked).toEqual([])
  })

  it("explicitly denies the known high-risk tables", () => {
    for (const t of [
      "tenant_integration_secrets",
      "tenant_connector_credentials",
      "billing_payments",
      "user_sessions",
      "api_keys",
      "legal_entity_bank_accounts",
      "tenant_domains",
    ]) {
      expect(isDemoCloneDenied(t)).toBe(true)
    }
    expect(DEMO_CLONE_DENYLIST.length).toBeGreaterThan(20)
  })

  it("purge covers every owned table except users/tenants (removed by deleteTenant)", () => {
    const purge = demoPurgeTables(TENANT_OWNED_TABLES)
    expect(purge).not.toContain("users")
    expect(purge).not.toContain("tenants")
    for (const t of DEMO_CLONE_DENYLIST) expect(purge).toContain(t)
    expect(purge).toContain("clients")
  })
})

describe("clone row construction", () => {
  const spec = DEMO_CLONE_TABLES.find((t) => t.table === "clients")!

  it("drops ids, remaps tenant, clears cross-tenant refs and regenerates unique values", () => {
    const row = buildClonedRow(
      spec,
      {
        id: 7,
        tenant_id: 1,
        created_at: "x",
        updated_at: "y",
        client_code: "DEMO-CLI-001",
        email: "a@x.test",
        created_by: 42,
        account_manager_id: 9,
        company_id: 3,
        login_allowed: "Yes",
        client_name: "Aarav",
      },
      55,
    )
    expect(row).not.toHaveProperty("id")
    expect(row).not.toHaveProperty("created_at")
    expect(row.tenant_id).toBe(55)
    expect(row.client_code).toBe("DEMO-CLI-001-D55")
    expect(row.email).toBe("a+d55@x.test")
    expect(row.created_by).toBeNull()
    expect(row.account_manager_id).toBeNull()
    expect(row.company_id).toBeNull()
    expect(row.login_allowed).toBe("No")
    expect(row.client_name).toBe("Aarav")
  })

  it("regenerates deterministically per tenant and differently across tenants", () => {
    expect(regenerateUniqueValue("C-1", 5)).toBe(regenerateUniqueValue("C-1", 5))
    expect(regenerateUniqueValue("C-1", 5)).not.toBe(regenerateUniqueValue("C-1", 6))
  })
})

describe("synthetic seed", () => {
  it("is obviously fabricated and uniquely coded", () => {
    const codes = DEMO_CLIENT_SEED.map((c) => c.client_code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of DEMO_CLIENT_SEED) {
      expect(c.client_code.startsWith("DEMO-")).toBe(true)
      expect(c.email).toMatch(/\.test$/)
      expect(c.company_name).toContain("(Demo)")
    }
  })
})

describe("input validation and expiry", () => {
  it("normalizes clone input with bounded label and TTL", () => {
    expect(normalizeCloneInput(undefined)).toEqual({ label: "Demo tenant", ttlDays: DEFAULT_TTL_DAYS })
    expect(normalizeCloneInput({ label: "  Acme pitch  ", ttlDays: 500 })).toEqual({ label: "Acme pitch", ttlDays: MAX_TTL_DAYS })
    expect(normalizeCloneInput({ label: "x".repeat(400), ttlDays: 0 }).label.length).toBe(120)
    expect(normalizeCloneInput({ ttlDays: 0 }).ttlDays).toBe(1)
    expect(clampTtlDays("abc")).toBe(DEFAULT_TTL_DAYS)
  })

  it("rejects bad extension values instead of clamping", () => {
    expect(parseExtendDays(7)).toBe(7)
    expect(parseExtendDays("7")).toBe(7)
    for (const bad of [0, 91, 1.5, "-1", "7d", null, undefined, {}]) expect(parseExtendDays(bad)).toBeNull()
  })

  it("computes, detects and extends expiry with a hard cap", () => {
    const exp = computeExpiresAt(now, 14)
    expect(exp.getTime() - now.getTime()).toBe(14 * DAY)
    expect(isDemoExpired(toSqlDatetime(exp), now)).toBe(false)
    expect(isDemoExpired(toSqlDatetime(exp), new Date(exp.getTime() + 1))).toBe(true)
    expect(demoDaysRemaining(toSqlDatetime(exp), now)).toBe(14)
    // SQL DATETIME strings round-trip as UTC.
    expect(parseDemoTime(toSqlDatetime(exp))).toBe(exp.getTime())
    // Extending an already-expired demo restarts from now.
    const past = toSqlDatetime(new Date(now.getTime() - 5 * DAY))
    expect(extendExpiry(past, now, 3).getTime()).toBe(now.getTime() + 3 * DAY)
    // Repeated extension can never exceed MAX_TTL_DAYS from now.
    const far = toSqlDatetime(new Date(now.getTime() + 80 * DAY))
    expect(extendExpiry(far, now, 90).getTime()).toBe(now.getTime() + MAX_TTL_DAYS * DAY)
  })
})

describe("purge authorization marker", () => {
  const clone = { slug: "demo-abc", plan: "demo", settings: JSON.stringify({ demo: { role: "clone", synthetic: true } }) }

  it("accepts only a fully marked synthetic clone", () => {
    expect(isDemoCloneTenantRecord(clone)).toBe(true)
    expect(isDemoCloneTenantRecord({ ...clone, settings: { demo: { role: "clone", synthetic: true } } })).toBe(true)
  })

  it("rejects real tenants, the template, the platform owner and partial markers", () => {
    expect(isDemoCloneTenantRecord(null)).toBe(false)
    expect(isDemoCloneTenantRecord({ ...clone, slug: "acme" })).toBe(false)
    expect(isDemoCloneTenantRecord({ ...clone, slug: DEMO_TEMPLATE_SLUG })).toBe(false)
    expect(isDemoCloneTenantRecord({ ...clone, plan: "standard" })).toBe(false)
    expect(isDemoCloneTenantRecord({ ...clone, is_platform_owner: 1 })).toBe(false)
    expect(isDemoCloneTenantRecord({ ...clone, settings: null })).toBe(false)
    expect(isDemoCloneTenantRecord({ ...clone, settings: { demo: { role: "clone" } } })).toBe(false)
    expect(isDemoCloneTenantRecord({ ...clone, settings: { demo: { role: "template", synthetic: true } } })).toBe(false)
  })
})

describe("idempotency key scoping", () => {
  it("scopes per operator and rejects unsafe keys", () => {
    expect(scopeIdempotencyKey(1, "abc")).toBe("1:abc")
    expect(scopeIdempotencyKey(2, "abc")).not.toBe(scopeIdempotencyKey(1, "abc"))
    expect(scopeIdempotencyKey(1, "  ")).toBeNull()
    expect(scopeIdempotencyKey(1, undefined)).toBeNull()
    expect(() => scopeIdempotencyKey(1, "a b")).toThrow()
    expect(() => scopeIdempotencyKey(1, "x".repeat(81))).toThrow()
  })
})
