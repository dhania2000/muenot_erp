import { beforeEach, describe, expect, it, vi } from "vitest"
import { MiniSql } from "./helpers/mini-sql"

/**
 * Spec26 — demo tenant store (#121-122). Runs the store's real SQL against the
 * in-memory engine, with tenant-service reimplemented on the same engine, to
 * prove clone repeatability, fresh ids/credentials, the never-copy rules,
 * cross-tenant isolation, idempotency, reset, expiry and cleanup — and that
 * none of it ever mutates the template or a real tenant.
 */

const db = new MiniSql()
const spies = vi.hoisted(() => ({
  audit: vi.fn(async (_e: any) => {}),
  revoke: vi.fn(async (_u: number, _o?: any) => 0),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: (sql: string, params?: any[]) => db.query(sql, params) }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: (e: any) => spies.audit(e) }))
vi.mock("@/lib/clients-db", () => ({ ensureClientTables: async () => {} }))
vi.mock("@/lib/user-lifecycle", () => ({ ensureUserLifecycleSchema: async () => {} }))
vi.mock("@/lib/session-store", () => ({ revokeAllSessionsForUser: (u: number, o: any) => spies.revoke(u, o) }))
vi.mock("@/lib/password", () => {
  let n = 0
  return {
    generateTempPassword: () => `Temp-${++n}-Pw!`,
    hashPassword: async (p: string) => `hash(${p})`,
  }
})
vi.mock("@/lib/tenant-service", () => {
  const byId = async (id: number) =>
    ((await db.query("SELECT * FROM `tenants` WHERE `id` = ? LIMIT 1", [id])) as any[])[0] ?? null
  const bySlug = async (slug: string) =>
    ((await db.query("SELECT * FROM `tenants` WHERE `slug` = ? LIMIT 1", [slug])) as any[])[0] ?? null
  return {
    getTenantById: byId,
    getTenantBySlug: bySlug,
    createTenant: async (input: any) => {
      if (await bySlug(input.slug)) throw new Error(`A tenant with slug "${input.slug}" already exists`)
      const res = await db.query(
        "INSERT INTO `tenants` (`name`, `slug`, `status`, `plan`, `tenant_type`, `settings`, `is_platform_owner`) VALUES (?, ?, 'active', ?, ?, ?, 0)",
        [input.name, input.slug, input.plan ?? "standard", input.tenant_type ?? "ENTERPRISE", input.settings ? JSON.stringify(input.settings) : null],
      )
      return byId(res.insertId)
    },
    setTenantStatus: async (id: number, status: string) => {
      await db.query("UPDATE `tenants` SET `status` = ? WHERE `id` = ?", [status, id])
      return byId(id)
    },
    deleteTenant: async (id: number) => {
      const t = await byId(id)
      if (!t) throw new Error("Tenant not found")
      if (t.is_platform_owner) throw new Error("The platform-owner tenant cannot be deleted")
      await db.query("DELETE FROM `users` WHERE `tenant_id` = ?", [id])
      await db.query("DELETE FROM `tenants` WHERE `id` = ?", [id])
      return t
    },
  }
})

import {
  cleanupDemoTenant,
  cleanupExpiredDemoTenants,
  cloneDemoTenant,
  ensureDemoTemplate,
  extendDemoTenant,
  forceExpireDemoTenant,
  getDemoTemplate,
  isActiveDemoTemplateTenant,
  listDemoTenants,
  resetDemoTenant,
} from "@/lib/demo-tenant-store"
import { DEMO_CLIENT_SEED, MAX_ACTIVE_DEMO_CLONES } from "@/lib/demo-tenant-model"

const operator = { userId: 1, email: "ops@muenot.test" }
const otherOperator = { userId: 2, email: "ops2@muenot.test" }
const DAY = 86_400_000

const tenantRows = () => db.rows("tenants")
const clientsOf = (tenantId: number) => db.rows("clients").filter((r) => Number(r.tenant_id) === tenantId)
const usersOf = (tenantId: number) => db.rows("users").filter((r) => Number(r.tenant_id) === tenantId)
const auditActions = () => spies.audit.mock.calls.map((c) => c[0].action)
const snapshot = (rows: any[]) => JSON.parse(JSON.stringify(rows))

/** A real customer tenant with real-looking data that must never be touched. */
async function seedRealTenant() {
  const res = await db.query(
    "INSERT INTO `tenants` (`name`, `slug`, `status`, `plan`, `settings`, `is_platform_owner`) VALUES ('Acme', 'acme', 'active', 'standard', NULL, 0)",
  )
  const id = res.insertId
  await db.query("INSERT INTO `users` (`tenant_id`, `email`, `password_hash`) VALUES (?, 'ceo@acme.com', 'real-hash')", [id])
  await db.query("INSERT INTO `clients` (`tenant_id`, `client_code`, `email`) VALUES (?, 'ACME-1', 'buyer@bigcorp.com')", [id])
  return id
}

beforeEach(() => {
  db.reset()
  spies.audit.mockClear()
  spies.revoke.mockClear()
})

describe("template", () => {
  it("creates one clearly marked, synthetic template idempotently", async () => {
    const a = await ensureDemoTemplate(operator)
    const b = await ensureDemoTemplate(operator)
    expect(a.id).toBe(b.id)
    expect(a.kind).toBe("template")
    const t = tenantRows().find((r) => r.id === a.tenantId)!
    expect(t.slug).toBe("demo-template")
    expect(t.plan).toBe("demo")
    expect(JSON.parse(t.settings).demo).toEqual({ role: "template", synthetic: true })
    expect(clientsOf(a.tenantId)).toHaveLength(DEMO_CLIENT_SEED.length)
    // Nobody can sign in to the template itself.
    expect(usersOf(a.tenantId)).toHaveLength(0)
    expect(auditActions().filter((x) => x === "demo_template_created")).toHaveLength(1)
  })

  it("refuses to adopt an unmarked tenant squatting on the template slug", async () => {
    await db.query(
      "INSERT INTO `tenants` (`name`, `slug`, `status`, `plan`, `settings`) VALUES ('Real', 'demo-template', 'active', 'standard', NULL)",
    )
    await expect(ensureDemoTemplate(operator)).rejects.toMatchObject({ status: 409 })
    expect(db.rows("clients")).toHaveLength(0)
  })
})

describe("clone", () => {
  it("provisions an isolated tenant with fresh ids, fresh credentials and copied synthetic data", async () => {
    const res = await cloneDemoTenant(operator, { label: "Acme pitch", ttlDays: 7 })
    const template = (await getDemoTemplate())!
    expect(res.replayed).toBe(false)
    expect(res.tenantId).not.toBe(template.tenantId)
    expect(res.adminTempPassword).toBeTruthy()
    expect(res.adminEmail).toMatch(/^demo-admin\+.+@demo\.muenot\.test$/)

    const tenant = tenantRows().find((r) => r.id === res.tenantId)!
    expect(tenant.slug).toMatch(/^demo-/)
    expect(JSON.parse(tenant.settings).demo).toMatchObject({ role: "clone", synthetic: true, sourceTemplateTenantId: template.tenantId })

    const [admin] = usersOf(res.tenantId)
    expect(usersOf(res.tenantId)).toHaveLength(1)
    expect(admin.password_hash).toBe(`hash(${res.adminTempPassword})`)
    expect(admin.must_change_password).toBe(1)
    expect(admin.access_expires_at).toBe(res.demo.expiresAt)

    const src = clientsOf(template.tenantId)
    const dst = clientsOf(res.tenantId)
    expect(dst).toHaveLength(src.length)
    const srcIds = new Set(src.map((r) => r.id))
    for (const row of dst) {
      expect(srcIds.has(row.id)).toBe(false)
      expect(row.client_code).toMatch(new RegExp(`-D${res.tenantId}$`))
      expect(row.email).toContain(`+d${res.tenantId}@`)
    }
    expect(res.demo.daysRemaining).toBe(7)
    expect(auditActions()).toContain("demo_tenant_cloned")
  })

  it("is repeatable: two clones are independent and never collide on unique keys", async () => {
    const a = await cloneDemoTenant(operator, { label: "A" })
    const b = await cloneDemoTenant(operator, { label: "B" })
    expect(a.tenantId).not.toBe(b.tenantId)
    expect(a.adminEmail).not.toBe(b.adminEmail)
    expect(a.adminTempPassword).not.toBe(b.adminTempPassword)
    expect(clientsOf(a.tenantId)).toHaveLength(DEMO_CLIENT_SEED.length)
    expect(clientsOf(b.tenantId)).toHaveLength(DEMO_CLIENT_SEED.length)
    const codes = db.rows("clients").map((r) => r.client_code)
    expect(new Set(codes).size).toBe(codes.length)
    expect((await listDemoTenants()).filter((d) => d.kind === "clone")).toHaveLength(2)
  })

  it("never copies secrets, integrations, billing, sessions, users or cross-tenant references", async () => {
    const template = await ensureDemoTemplate(operator)
    const t = template.tenantId
    await db.query("INSERT INTO `tenant_integration_secrets` (`tenant_id`, `name`, `ciphertext`) VALUES (?, 'stripe', 'enc')", [t])
    await db.query("INSERT INTO `tenant_connector_credentials` (`tenant_id`, `token`) VALUES (?, 'tok')", [t])
    await db.query("INSERT INTO `billing_payments` (`tenant_id`, `amount`) VALUES (?, 100)", [t])
    await db.query("INSERT INTO `legal_entity_bank_accounts` (`tenant_id`, `iban`) VALUES (?, 'DE00')", [t])
    await db.query("INSERT INTO `api_keys` (`tenant_id`, `hash`) VALUES (?, 'k')", [t])
    await db.query("INSERT INTO `users` (`tenant_id`, `email`) VALUES (?, 'someone@template.test')", [t])
    // A template row that (wrongly) references another row in the template.
    await db.query(
      "INSERT INTO `clients` (`tenant_id`, `client_code`, `email`, `created_by`, `account_manager_id`, `login_allowed`) VALUES (?, 'DEMO-X', 'x@demo.test', 999, 998, 'Yes')",
      [t],
    )

    const res = await cloneDemoTenant(operator, {})
    for (const table of ["tenant_integration_secrets", "tenant_connector_credentials", "billing_payments", "legal_entity_bank_accounts", "api_keys"]) {
      expect(db.rows(table).filter((r) => r.tenant_id === res.tenantId)).toHaveLength(0)
    }
    expect(usersOf(res.tenantId).map((u) => u.email)).toEqual([res.adminEmail])
    const copied = clientsOf(res.tenantId).find((r) => String(r.client_code).startsWith("DEMO-X"))!
    expect(copied.created_by).toBeNull()
    expect(copied.account_manager_id).toBeNull()
    expect(copied.login_allowed).toBe("No")
  })

  it("does not read or modify real tenants or the template", async () => {
    const realId = await seedRealTenant()
    await ensureDemoTemplate(operator)
    const before = snapshot([...db.rows("clients"), ...db.rows("users"), ...tenantRows()])
    const res = await cloneDemoTenant(operator, {})
    const after = snapshot([...db.rows("clients"), ...db.rows("users"), ...tenantRows()]).filter(
      (r: any) => r.tenant_id !== res.tenantId && r.id !== res.tenantId,
    )
    expect(after).toEqual(before.filter((r: any) => r.id !== res.tenantId))
    expect(clientsOf(res.tenantId).some((r) => String(r.email).includes("bigcorp"))).toBe(false)
    expect(clientsOf(realId)).toHaveLength(1)
  })

  it("replays an idempotent retry without a second tenant or a re-issued password", async () => {
    const first = await cloneDemoTenant(operator, { label: "X" }, "retry-1")
    const second = await cloneDemoTenant(operator, { label: "X" }, "retry-1")
    expect(second.replayed).toBe(true)
    expect(second.tenantId).toBe(first.tenantId)
    expect(second.adminTempPassword).toBeNull()
    expect(db.rows("demo_tenants").filter((r) => r.kind === "clone")).toHaveLength(1)
  })

  it("scopes idempotency keys per operator so one operator cannot replay another's clone", async () => {
    const mine = await cloneDemoTenant(operator, {}, "same-key")
    const theirs = await cloneDemoTenant(otherOperator, {}, "same-key")
    expect(theirs.replayed).toBe(false)
    expect(theirs.tenantId).not.toBe(mine.tenantId)
  })

  it("rejects malformed idempotency keys before creating anything", async () => {
    await expect(cloneDemoTenant(operator, {}, "bad key!")).rejects.toMatchObject({ status: 400 })
    expect(tenantRows()).toHaveLength(0)
  })

  it("rolls back a partially built clone when copying fails", async () => {
    const template = await ensureDemoTemplate(operator)
    const tenantsBefore = tenantRows().length
    db.custom = (sql, params) => {
      if (/^\s*INSERT INTO `clients`/.test(sql) && params[params.length - 1] !== undefined) {
        const tenantCol = sql.match(/\((.*?)\) VALUES/)![1].split(",").map((c) => c.replace(/[`\s]/g, "")).indexOf("tenant_id")
        if (params[tenantCol] !== template.tenantId) throw Object.assign(new Error("disk full"), { errno: 1021 })
      }
      return undefined
    }
    await expect(cloneDemoTenant(operator, {})).rejects.toMatchObject({ status: 500 })
    db.custom = null
    expect(tenantRows()).toHaveLength(tenantsBefore)
    expect(db.rows("users")).toHaveLength(0)
    expect(db.rows("demo_tenants").filter((r) => r.kind === "clone")).toHaveLength(0)
    expect(clientsOf(template.tenantId)).toHaveLength(DEMO_CLIENT_SEED.length)
    expect(auditActions()).toContain("demo_tenant_clone_failed")
  })

  it("caps concurrently active clones", async () => {
    await ensureDemoTemplate(operator)
    for (let i = 0; i < MAX_ACTIVE_DEMO_CLONES; i++) {
      await db.query("INSERT INTO `demo_tenants` (`tenant_id`, `kind`, `status`) VALUES (?, 'clone', 'active')", [1000 + i])
    }
    await expect(cloneDemoTenant(operator, {})).rejects.toMatchObject({ status: 429 })
  })
})

describe("reset", () => {
  it("restores the template dataset, discards demo edits and leaves the template intact", async () => {
    const res = await cloneDemoTenant(operator, {})
    const template = (await getDemoTemplate())!
    const templateBefore = snapshot(clientsOf(template.tenantId))

    await db.query("DELETE FROM `clients` WHERE `tenant_id` = ? AND `client_code` = ?", [res.tenantId, `DEMO-CLI-001-D${res.tenantId}`])
    await db.query("INSERT INTO `clients` (`tenant_id`, `client_code`, `email`) VALUES (?, 'USER-ADDED', 'u@demo.test')", [res.tenantId])

    const reset = await resetDemoTenant(operator, res.demo.id)
    expect(reset.adminTempPassword).toBeNull()
    const codes = clientsOf(res.tenantId).map((r) => r.client_code).sort()
    expect(codes).toEqual(DEMO_CLIENT_SEED.map((c) => `${c.client_code}-D${res.tenantId}`).sort())
    expect(snapshot(clientsOf(template.tenantId))).toEqual(templateBefore)
    expect(reset.demo.lastResetAt).toBeTruthy()
    expect(auditActions()).toContain("demo_tenant_reset")
  })

  it("is repeatable (reset twice yields the same dataset)", async () => {
    const res = await cloneDemoTenant(operator, {})
    await resetDemoTenant(operator, res.demo.id)
    const once = clientsOf(res.tenantId).map((r) => r.client_code).sort()
    await resetDemoTenant(operator, res.demo.id)
    expect(clientsOf(res.tenantId).map((r) => r.client_code).sort()).toEqual(once)
  })

  it("rotates credentials and revokes the admin's sessions on request", async () => {
    const res = await cloneDemoTenant(operator, {})
    const oldHash = usersOf(res.tenantId)[0].password_hash
    const reset = await resetDemoTenant(operator, res.demo.id, { rotateCredentials: true })
    expect(reset.adminTempPassword).toBeTruthy()
    expect(usersOf(res.tenantId)[0].password_hash).not.toBe(oldHash)
    expect(spies.revoke).toHaveBeenCalledWith(res.demo.adminUserId, expect.objectContaining({ reason: "demo_credentials_rotated" }))
  })

  it("refuses to act on the template or unknown ids", async () => {
    const template = await ensureDemoTemplate(operator)
    await expect(resetDemoTenant(operator, template.id)).rejects.toMatchObject({ status: 400 })
    await expect(extendDemoTenant(operator, template.id, 5)).rejects.toMatchObject({ status: 400 })
    await expect(cleanupDemoTenant(operator, template.id)).rejects.toMatchObject({ status: 400 })
    await expect(resetDemoTenant(operator, 9999)).rejects.toMatchObject({ status: 404 })
  })
})

describe("expiry, extension and cleanup", () => {
  it("expires overdue clones: suspends tenant, blocks sign-in and revokes sessions", async () => {
    const res = await cloneDemoTenant(operator, { ttlDays: 3 })
    const summary = await cleanupExpiredDemoTenants(null, new Date(Date.now() + 4 * DAY))
    expect(summary.expired).toBe(1)
    expect(summary.purged).toBe(1)
    expect(spies.revoke).toHaveBeenCalledWith(res.demo.adminUserId, expect.objectContaining({ reason: "demo_expired" }))
    expect(auditActions()).toEqual(expect.arrayContaining(["demo_tenant_expired", "demo_tenant_cleaned"]))
  })

  it("purges only the expired clone and leaves other clones, the template and real tenants untouched", async () => {
    const realId = await seedRealTenant()
    const doomed = await cloneDemoTenant(operator, { ttlDays: 1 })
    const keeper = await cloneDemoTenant(operator, { ttlDays: 30 })
    const template = (await getDemoTemplate())!
    // Demo user activity in the doomed clone, including a secret they connected.
    await db.query("INSERT INTO `sales_leads` (`tenant_id`, `name`) VALUES (?, 'lead')", [doomed.tenantId])
    await db.query("INSERT INTO `tenant_integration_secrets` (`tenant_id`, `name`) VALUES (?, 's')", [doomed.tenantId])
    const templateBefore = snapshot(clientsOf(template.tenantId))

    const summary = await cleanupExpiredDemoTenants(null, new Date(Date.now() + 2 * DAY))
    expect(summary.purgedTenantIds).toEqual([doomed.tenantId])
    expect(summary.failed).toEqual([])

    expect(tenantRows().some((r) => r.id === doomed.tenantId)).toBe(false)
    for (const table of ["clients", "users", "sales_leads", "tenant_integration_secrets"]) {
      expect(db.rows(table).filter((r) => r.tenant_id === doomed.tenantId)).toHaveLength(0)
    }
    expect(clientsOf(keeper.tenantId)).toHaveLength(DEMO_CLIENT_SEED.length)
    expect(usersOf(keeper.tenantId)).toHaveLength(1)
    expect(snapshot(clientsOf(template.tenantId))).toEqual(templateBefore)
    expect(clientsOf(realId)).toHaveLength(1)
    expect(usersOf(realId)).toHaveLength(1)

    const registry = await listDemoTenants()
    expect(registry.find((d) => d.id === doomed.demo.id)!.status).toBe("cleaned")
    expect(registry.find((d) => d.id === keeper.demo.id)!.status).toBe("active")
  })

  it("is idempotent: a second sweep does nothing", async () => {
    await cloneDemoTenant(operator, { ttlDays: 1 })
    const later = new Date(Date.now() + 2 * DAY)
    await cleanupExpiredDemoTenants(null, later)
    expect(await cleanupExpiredDemoTenants(null, later)).toEqual({ expired: 0, purged: 0, purgedTenantIds: [], failed: [] })
  })

  it("refuses to purge a tenant that is not marked as a synthetic clone (corrupt registry)", async () => {
    const realId = await seedRealTenant()
    await db.query("INSERT INTO `demo_tenants` (`tenant_id`, `kind`, `status`) VALUES (?, 'clone', 'expired')", [realId])
    const summary = await cleanupExpiredDemoTenants(null)
    expect(summary.purged).toBe(0)
    expect(summary.failed).toHaveLength(1)
    expect(tenantRows().some((r) => r.id === realId)).toBe(true)
    expect(clientsOf(realId)).toHaveLength(1)
    expect(usersOf(realId)).toHaveLength(1)
  })

  it("supports manual expire, extend (reactivates) and cleanup of one clone", async () => {
    const res = await cloneDemoTenant(operator, { ttlDays: 5 })
    const expired = await forceExpireDemoTenant(operator, res.demo.id)
    expect(expired.status).toBe("expired")
    expect(tenantRows().find((r) => r.id === res.tenantId)!.status).toBe("suspended")

    const extended = await extendDemoTenant(operator, res.demo.id, 10)
    expect(extended.status).toBe("active")
    // Force-expiry keeps the original deadline, so extension adds on top of it.
    expect(extended.daysRemaining).toBe(15)
    expect(tenantRows().find((r) => r.id === res.tenantId)!.status).toBe("active")
    expect(usersOf(res.tenantId)[0].access_expires_at).toBe(extended.expiresAt)
    await expect(extendDemoTenant(operator, res.demo.id, 0)).rejects.toMatchObject({ status: 400 })

    const cleaned = await cleanupDemoTenant(operator, res.demo.id)
    expect(cleaned.status).toBe("cleaned")
    expect(tenantRows().some((r) => r.id === res.tenantId)).toBe(false)
    await expect(cleanupDemoTenant(operator, res.demo.id)).rejects.toMatchObject({ status: 409 })
  })

  it("flags the active template so generic tenant deletion can refuse it", async () => {
    const template = await ensureDemoTemplate(operator)
    const clone = await cloneDemoTenant(operator, {})
    expect(await isActiveDemoTemplateTenant(template.tenantId)).toBe(true)
    expect(await isActiveDemoTemplateTenant(clone.tenantId)).toBe(false)
  })
})
