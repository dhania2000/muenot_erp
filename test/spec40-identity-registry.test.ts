import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  query: vi.fn(),
  tableColumns: vi.fn(),
  withTransaction: vi.fn(),
  requireTenant: vi.fn(),
  checker: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query, tableColumns: m.tableColumns, withTransaction: m.withTransaction }))
vi.mock("@/lib/api-auth", () => ({ requireTenant: m.requireTenant }))
vi.mock("@/lib/permissions", () => ({ getFeatureChecker: m.checker }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLogFromRequest: m.audit }))

import {
  canonicalKey,
  detectMergeCollisions,
  evaluateMergeAuthority,
  isAllowedSourceModule,
  normalizeAttr,
  parseIdentityId,
  validateMerge,
} from "@/lib/identity-registry/model"
import { mapIdentity, mergeIdentities } from "@/lib/identity-registry/store"
import { GET as idGET, POST as idPOST } from "@/app/api/master-data/identities/route"

/**
 * SPEC 40 — unified identity registry. The graph is only safe if equivalent
 * references normalise the same, colliding attributes block a silent overwrite,
 * illegal/self/duplicate merges are refused, and every merge is tenant-scoped,
 * authorised and idempotent.
 */

describe("normalisation (duplicate detection)", () => {
  it("collapses formatting differences per attribute type", () => {
    expect(normalizeAttr("email", "  A@B.com ")).toBe("a@b.com")
    expect(normalizeAttr("phone", "+1 (555) 123-4567")).toBe("5551234567")
    expect(normalizeAttr("tax_id", "27abcde 1234f 1z5")).toBe("27ABCDE1234F1Z5")
    expect(normalizeAttr("domain", "https://www.Acme.com/path")).toBe("acme.com")
    expect(normalizeAttr("name", "Acme Pvt Ltd")).toBe("acme")
  })
})

describe("merge collision detection", () => {
  it("flags only attributes both sides populate AND disagree on", () => {
    const collisions = detectMergeCollisions(
      { email: "a@b.com", tax_id: "GST1", phone: "" },
      { email: "a@b.com", tax_id: "GST2", phone: "999" },
    )
    // email agrees (no collision), phone only on one side (complementary), tax_id differs
    expect(collisions.map((c) => c.field)).toEqual(["tax_id"])
    expect(collisions[0]).toMatchObject({ survivor: "GST1", merged: "GST2" })
  })

  it("treats normalised-equal values as non-colliding", () => {
    expect(detectMergeCollisions({ email: "A@B.com" }, { email: "a@b.com " })).toEqual([])
  })
})

describe("merge legality", () => {
  const base = { kind: "party" as const, survivorKind: "party" as const, mergedKind: "party" as const }

  it("refuses a self-merge", () => {
    expect(validateMerge({ ...base, survivorId: 5, mergedId: 5 })).toMatchObject({ ok: false })
  })
  it("refuses a cross-kind merge", () => {
    expect(validateMerge({ ...base, survivorId: 1, mergedId: 2, mergedKind: "employee" })).toMatchObject({ ok: false })
  })
  it("refuses re-merging an already-merged identity", () => {
    expect(validateMerge({ ...base, survivorId: 1, mergedId: 2, mergedAlreadyMerged: true })).toMatchObject({ ok: false })
  })
  it("refuses merging into a tombstone survivor", () => {
    expect(validateMerge({ ...base, survivorId: 1, mergedId: 2, survivorIsTombstone: true })).toMatchObject({ ok: false })
  })
  it("accepts a clean merge", () => {
    expect(validateMerge({ ...base, survivorId: 1, mergedId: 2 })).toEqual({ ok: true })
  })
})

describe("authority + source-module + id helpers", () => {
  it("gates merges on admin or governance grant", () => {
    expect(evaluateMergeAuthority({ actorIsAdmin: true, actorHasGovernanceGrant: false }).ok).toBe(true)
    expect(evaluateMergeAuthority({ actorIsAdmin: false, actorHasGovernanceGrant: true }).ok).toBe(true)
    expect(evaluateMergeAuthority({ actorIsAdmin: false, actorHasGovernanceGrant: false }).ok).toBe(false)
  })
  it("rejects a cross-kind source module", () => {
    expect(isAllowedSourceModule("party", "crm")).toBe(true)
    expect(isAllowedSourceModule("party", "payroll")).toBe(false)
    expect(isAllowedSourceModule("employee", "hr")).toBe(true)
  })
  it("parses ids strictly", () => {
    expect(parseIdentityId("42")).toBe(42)
    expect(parseIdentityId("0")).toBeNull()
    expect(parseIdentityId("-1")).toBeNull()
    expect(parseIdentityId("abc")).toBeNull()
  })
  it("builds a stable canonical key", () => {
    expect(canonicalKey("party", 7)).toBe("party:7")
  })
})

describe("store: mapIdentity", () => {
  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset()
    m.tableColumns.mockResolvedValue(
      new Set(["tenant_id", "identity_kind", "canonical_key", "source_module", "source_id", "status", "survivor_key", "merged_key", "idempotency_key"]),
    )
  })

  it("rejects a cross-kind reference before writing", async () => {
    await expect(
      mapIdentity(1, { kind: "party", canonicalId: 3, sourceModule: "payroll", sourceId: 9 }),
    ).rejects.toMatchObject({ code: "invalid" })
    expect(m.query).not.toHaveBeenCalled()
  })

  it("upserts a mapping bound to the tenant", async () => {
    m.query.mockResolvedValue({ affectedRows: 1 })
    const entry = await mapIdentity(2, { kind: "party", canonicalId: 3, sourceModule: "crm", sourceId: 9, externalRef: "CUST-9" })
    expect(entry.canonicalKey).toBe("party:3")
    expect(m.query.mock.calls[0][1][0]).toBe(2) // tenant id first bind
  })
})

describe("store: mergeIdentities (tenant scope, collisions, idempotency)", () => {
  const actor = { userId: 7, isAdmin: true, hasGovernanceGrant: true }
  const schema = () =>
    m.tableColumns.mockResolvedValue(
      new Set(["tenant_id", "identity_kind", "canonical_key", "source_module", "source_id", "status", "survivor_key", "merged_key", "idempotency_key"]),
    )

  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset()
    schema()
  })

  it("blocks a non-authorised actor", async () => {
    await expect(
      mergeIdentities(1, { kind: "party", survivorId: 1, mergedId: 2, idempotencyKey: "k1" }, { userId: 7, isAdmin: false, hasGovernanceGrant: false }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 })
  })

  it("replays a prior merge with the same idempotency key (no re-run)", async () => {
    m.query.mockResolvedValueOnce([{ survivor_key: "party:1", merged_key: "party:2", collisions: null }])
    const res = await mergeIdentities(1, { kind: "party", survivorId: 1, mergedId: 2, idempotencyKey: "k1" }, actor)
    expect(res.reused).toBe(true)
    expect(m.withTransaction).not.toHaveBeenCalled()
  })

  it("rejects reuse of an idempotency key for a different merge", async () => {
    m.query.mockResolvedValueOnce([{ survivor_key: "party:9", merged_key: "party:8", collisions: null }])
    await expect(
      mergeIdentities(1, { kind: "party", survivorId: 1, mergedId: 2, idempotencyKey: "k1" }, actor),
    ).rejects.toMatchObject({ code: "conflict", status: 409 })
  })

  it("blocks an unacknowledged collision", async () => {
    // 1) idempotency lookup empty, 2) mergedAway empty, 3) survivorTombstone empty
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await expect(
      mergeIdentities(
        1,
        { kind: "party", survivorId: 1, mergedId: 2, survivorAttrs: { tax_id: "A" }, mergedAttrs: { tax_id: "B" }, idempotencyKey: "k2" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 })
    expect(m.withTransaction).not.toHaveBeenCalled()
  })

  it("performs the merge inside a transaction when clean, re-linking references", async () => {
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    m.withTransaction.mockImplementation(async (fn: any) =>
      fn({ query: vi.fn().mockResolvedValueOnce([{ affectedRows: 3 }]).mockResolvedValueOnce([{}]) }),
    )
    const res = await mergeIdentities(1, { kind: "party", survivorId: 1, mergedId: 2, idempotencyKey: "k3" }, actor)
    expect(res.reused).toBe(false)
    expect(res.relinked).toBe(3)
    expect(res.survivorKey).toBe("party:1")
    expect(m.withTransaction).toHaveBeenCalledTimes(1)
  })

  it("allows an acknowledged collision to proceed", async () => {
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    m.withTransaction.mockImplementation(async (fn: any) =>
      fn({ query: vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([{}]) }),
    )
    const res = await mergeIdentities(
      1,
      { kind: "party", survivorId: 1, mergedId: 2, survivorAttrs: { tax_id: "A" }, mergedAttrs: { tax_id: "B" }, acknowledgeCollisions: true, idempotencyKey: "k4" },
      actor,
    )
    expect(res.collisions).toHaveLength(1)
    expect(res.reused).toBe(false)
  })
})

describe("identities API (access scope + tenant separation)", () => {
  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset()
    m.requireTenant.mockResolvedValue({ session: { userId: 7, role: "employee" }, tenantId: 5 })
    m.audit.mockResolvedValue(undefined)
    m.tableColumns.mockResolvedValue(
      new Set(["tenant_id", "identity_kind", "canonical_key", "source_module", "source_id", "status", "survivor_key", "merged_key", "idempotency_key"]),
    )
  })

  const jreq = (body: unknown) =>
    new Request("http://x/api/master-data/identities", { method: "POST", body: JSON.stringify(body) })

  it("401s without a session", async () => {
    m.requireTenant.mockResolvedValue(null)
    expect((await idGET(new Request("http://x/api/master-data/identities"))).status).toBe(401)
  })

  it("403s a merge without the governance grant (and audits the denial)", async () => {
    m.checker.mockResolvedValue(() => false)
    const res = await idPOST(jreq({ action: "merge", kind: "party", survivorId: 1, mergedId: 2, idempotencyKey: "k" }))
    expect(res.status).toBe(403)
    expect(m.audit.mock.calls.at(-1)![1].result).toBe("denied")
  })

  it("surfaces a collision conflict with details from the store", async () => {
    m.checker.mockResolvedValue(() => true)
    m.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const res = await idPOST(
      jreq({
        action: "merge",
        kind: "party",
        survivorId: 1,
        mergedId: 2,
        survivorAttrs: { tax_id: "A" },
        mergedAttrs: { tax_id: "B" },
        idempotencyKey: "kk",
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.details.collisions).toHaveLength(1)
  })

  it("binds the caller's tenant id when listing history", async () => {
    m.checker.mockResolvedValue(() => true)
    m.query.mockResolvedValue([])
    await idGET(new Request("http://x/api/master-data/identities"))
    expect(m.query.mock.calls[0][1][0]).toBe(5) // tenant id from session, not client-supplied
  })
})
