import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Multi-organization membership: role boundaries, primary-membership
 * protection, idempotent upsert, and the switching-isolation gate
 * (`isActiveMembership`) that every non-home tenant scope must pass through.
 *
 * The DB layer is mocked so each test asserts the exact SQL + params the
 * membership helpers emit, without a live MySQL.
 */

const query = vi.fn()
vi.mock("@/lib/db", () => ({ query: (...args: any[]) => query(...args) }))
vi.mock("@/lib/tenant-service", () => ({
  ensureTenantSchema: vi.fn(async () => {}),
  DEFAULT_TENANT_SLUG: "muenot",
}))

import {
  addMembership,
  removeMembership,
  isActiveMembership,
  getMembershipRole,
  listMembershipsForUser,
  MembershipError,
} from "@/lib/tenant-membership"

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()
const findCall = (needle: string) => query.mock.calls.find(([sql]) => norm(sql).includes(needle))

beforeEach(() => {
  query.mockReset()
  // Default: everything (schema self-heal, FK probes, backfill) is benign.
  query.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

const membershipRow = {
  id: 10,
  user_id: 5,
  tenant_id: 2,
  tenant_role: "tenant_admin",
  is_primary: 0,
  status: "active",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
}

function routeReads(overrides: (s: string, params: any[]) => any | undefined) {
  query.mockImplementation(async (sql: string, params: any[] = []) => {
    const s = norm(sql)
    const custom = overrides(s, params)
    if (custom !== undefined) return custom
    return []
  })
}

describe("addMembership (validation + role boundaries)", () => {
  it("rejects a non-positive userId", async () => {
    await expect(addMembership({ userId: 0, tenantId: 2 })).rejects.toBeInstanceOf(MembershipError)
  })

  it("404s when the user does not exist", async () => {
    routeReads((s) => {
      if (s.includes("FROM `users` WHERE id =")) return []
      if (s.includes("FROM `tenants` WHERE id =")) return [{ "1": 1 }]
    })
    await expect(addMembership({ userId: 5, tenantId: 2 })).rejects.toMatchObject({ status: 404 })
  })

  it("upserts with the requested role and stamps it in the INSERT", async () => {
    routeReads((s) => {
      if (s.includes("FROM `users` WHERE id =")) return [{ "1": 1 }]
      if (s.includes("FROM `tenants` WHERE id =")) return [{ "1": 1 }]
      if (s.startsWith("SELECT * FROM `user_tenant_memberships` WHERE `user_id`"))
        return [{ ...membershipRow, tenant_role: "tenant_owner" }]
    })
    const result = await addMembership({ userId: 5, tenantId: 2, tenantRole: "tenant_owner" })
    expect(result.tenantRole).toBe("tenant_owner")
    const insert = findCall("INSERT INTO `user_tenant_memberships`")
    expect(insert?.[1]).toContain("tenant_owner")
  })

  it("coerces an unknown role down to employee (role boundary)", async () => {
    routeReads((s) => {
      if (s.includes("FROM `users` WHERE id =")) return [{ "1": 1 }]
      if (s.includes("FROM `tenants` WHERE id =")) return [{ "1": 1 }]
      if (s.startsWith("SELECT * FROM `user_tenant_memberships` WHERE `user_id`")) return [membershipRow]
    })
    await addMembership({ userId: 5, tenantId: 2, tenantRole: "superadmin" as any })
    const insert = findCall("INSERT INTO `user_tenant_memberships`")
    expect(insert?.[1]).toContain("employee")
    expect(insert?.[1]).not.toContain("superadmin")
  })

  it("demotes any existing primary when granting a new primary membership", async () => {
    routeReads((s) => {
      if (s.includes("FROM `users` WHERE id =")) return [{ "1": 1 }]
      if (s.includes("FROM `tenants` WHERE id =")) return [{ "1": 1 }]
      if (s.startsWith("SELECT * FROM `user_tenant_memberships` WHERE `user_id`"))
        return [{ ...membershipRow, is_primary: 1 }]
    })
    await addMembership({ userId: 5, tenantId: 2, isPrimary: true })
    expect(findCall("SET `is_primary` = 0 WHERE `user_id` = ?")).toBeTruthy()
  })
})

describe("removeMembership (primary protection)", () => {
  it("refuses to remove the user's primary organization", async () => {
    routeReads((s) => {
      if (s.startsWith("SELECT * FROM `user_tenant_memberships` WHERE `user_id`"))
        return [{ ...membershipRow, is_primary: 1 }]
    })
    await expect(removeMembership(5, 2)).rejects.toMatchObject({ status: 409 })
    expect(findCall("DELETE FROM `user_tenant_memberships`")).toBeFalsy()
  })

  it("404s when there is no such membership", async () => {
    routeReads((s) => {
      if (s.startsWith("SELECT * FROM `user_tenant_memberships` WHERE `user_id`")) return []
    })
    await expect(removeMembership(5, 2)).rejects.toMatchObject({ status: 404 })
  })

  it("deletes a non-primary membership", async () => {
    routeReads((s) => {
      if (s.startsWith("SELECT * FROM `user_tenant_memberships` WHERE `user_id`")) return [membershipRow]
    })
    await removeMembership(5, 2)
    const del = findCall("DELETE FROM `user_tenant_memberships`")
    expect(del?.[1]).toEqual([5, 2])
  })
})

describe("isActiveMembership (switching-isolation gate)", () => {
  it("requires BOTH an active membership AND an active tenant", async () => {
    routeReads((s) => {
      if (s.includes("FROM `user_tenant_memberships` m")) return []
    })
    const allowed = await isActiveMembership(5, 999)
    expect(allowed).toBe(false)
    const gate = findCall("FROM `user_tenant_memberships` m")
    // The gate must constrain on both the membership status and the tenant status.
    expect(norm(gate![0])).toContain("m.status = 'active'")
    expect(norm(gate![0])).toContain("t.status = 'active'")
  })

  it("allows a live membership in an active tenant", async () => {
    routeReads((s) => {
      if (s.includes("FROM `user_tenant_memberships` m")) return [{ "1": 1 }]
    })
    expect(await isActiveMembership(5, 2)).toBe(true)
  })
})

describe("getMembershipRole", () => {
  it("returns the role for an active membership", async () => {
    routeReads((s) => {
      if (s.includes("SELECT `tenant_role` FROM `user_tenant_memberships`"))
        return [{ tenant_role: "module_admin" }]
    })
    expect(await getMembershipRole(5, 2)).toBe("module_admin")
  })

  it("returns null when the user is not a member", async () => {
    routeReads((s) => {
      if (s.includes("SELECT `tenant_role` FROM `user_tenant_memberships`")) return []
    })
    expect(await getMembershipRole(5, 2)).toBeNull()
  })
})

describe("listMembershipsForUser", () => {
  it("maps rows and joins the tenant name/slug", async () => {
    routeReads((s) => {
      if (s.includes("FROM `user_tenant_memberships` m") && s.includes("tenant_name"))
        return [
          { ...membershipRow, tenant_id: 1, tenant_name: "Muenot", tenant_slug: "muenot", is_primary: 1 },
          { ...membershipRow, id: 11, tenant_id: 2, tenant_name: "Acme", tenant_slug: "acme" },
        ]
    })
    const list = await listMembershipsForUser(5)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ tenantId: 1, tenantName: "Muenot", tenantSlug: "muenot", isPrimary: true })
    expect(list[1]).toMatchObject({ tenantId: 2, tenantName: "Acme", tenantSlug: "acme" })
  })
})
