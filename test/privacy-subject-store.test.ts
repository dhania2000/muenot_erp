import { beforeEach, describe, expect, it, vi } from "vitest"
import { MiniSql } from "./helpers/mini-sql"

/**
 * Spec24 — data-subject request store (#154). Runs the store's real governance
 * SQL against the in-memory engine while mocking the retention/legal-hold/schema
 * dependencies, to prove: duplicate OPEN requests are rejected (idempotency),
 * the approval + run gate is enforced server-side, a retention obligation
 * downgrades an erase to an anonymize while a legal hold blocks a location
 * entirely, cross-tenant isolation, and that every step writes audit evidence.
 */

const db = new MiniSql()
const audit = vi.hoisted(() => ({ recordAuditLog: vi.fn(async () => {}) }))
const deps = vi.hoisted(() => ({
  tableColumns: vi.fn(async (_t: string) => new Set<string>()),
  listPolicies: vi.fn(async () => [] as any[]),
  getPolicyHoldCoverage: vi.fn(async () => ({ fullyHeld: false, holdNames: [], recordRefs: [], criteria: [] })),
}))

vi.mock("@/lib/db", () => ({
  query: (sql: string, params?: any[]) => db.query(sql, params),
  tableColumns: (t: string) => deps.tableColumns(t),
}))
vi.mock("@/lib/audit-log-store", () => audit)
vi.mock("@/lib/retention-engine", () => ({ listPolicies: () => deps.listPolicies() }))
vi.mock("@/lib/legal-hold-store", () => ({ getPolicyHoldCoverage: (t: number, c: any) => deps.getPolicyHoldCoverage(t, c) }))

import {
  createSubjectRequest,
  decideSubjectRequest,
  getSubjectRequest,
  planSubjectRequest,
  runSubjectRequest,
} from "@/lib/privacy-subject-store"

const actor = { userId: 1, name: "Admin", email: "admin@t.test", role: "owner" }
const TENANT_A = 10
const TENANT_B = 20

beforeEach(() => {
  db.reset()
  audit.recordAuditLog.mockClear()
  deps.tableColumns.mockReset()
  deps.tableColumns.mockResolvedValue(new Set<string>())
  deps.listPolicies.mockReset()
  deps.listPolicies.mockResolvedValue([])
  deps.getPolicyHoldCoverage.mockReset()
  deps.getPolicyHoldCoverage.mockResolvedValue({ fullyHeld: false, holdNames: [], recordRefs: [], criteria: [] })
})

describe("creating requests", () => {
  it("creates a request and writes audit evidence", async () => {
    const req = await createSubjectRequest(TENANT_A, { kind: "export", subjectEmail: "Jane@Example.com" }, actor)
    expect(req.status).toBe("pending")
    expect(req.subjectEmail).toBe("jane@example.com")
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.subject_request.created" }),
      undefined,
    )
  })

  it("rejects a duplicate OPEN request of the same kind + subject", async () => {
    await createSubjectRequest(TENANT_A, { kind: "erase", subjectEmail: "dup@example.com" }, actor)
    await expect(
      createSubjectRequest(TENANT_A, { kind: "erase", subjectEmail: "dup@example.com" }, actor),
    ).rejects.toThrow(/open request of this type already exists/i)
  })

  it("allows the same kind for a different tenant (isolation)", async () => {
    await createSubjectRequest(TENANT_A, { kind: "erase", subjectEmail: "iso@example.com" }, actor)
    await expect(
      createSubjectRequest(TENANT_B, { kind: "erase", subjectEmail: "iso@example.com" }, actor),
    ).resolves.toMatchObject({ tenantId: TENANT_B })
  })
})

describe("approval + run gate", () => {
  it("a destructive request cannot run before approval", async () => {
    const req = await createSubjectRequest(TENANT_A, { kind: "erase", subjectEmail: "gate@example.com" }, actor)
    await expect(runSubjectRequest(TENANT_A, req.id, actor)).rejects.toThrow(/must be approved/i)
  })

  it("approve then run executes and audits the erase", async () => {
    const req = await createSubjectRequest(TENANT_A, { kind: "erase", subjectEmail: "run@example.com" }, actor)
    await decideSubjectRequest(TENANT_A, req.id, "approve", actor)
    const result = await runSubjectRequest(TENANT_A, req.id, actor)
    expect(result.request.status).toBe("completed")
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.subject_request.executed" }),
      undefined,
    )
  })

  it("rejecting a request records the decision and blocks running it", async () => {
    const req = await createSubjectRequest(TENANT_A, { kind: "anonymize", subjectEmail: "rej@example.com" }, actor)
    const decided = await decideSubjectRequest(TENANT_A, req.id, "reject", actor)
    expect(decided.status).toBe("rejected")
    await expect(runSubjectRequest(TENANT_A, req.id, actor)).rejects.toThrow()
  })

  it("export runs straight from pending without an approval", async () => {
    const req = await createSubjectRequest(TENANT_A, { kind: "export", subjectEmail: "exp@example.com" }, actor)
    const result = await runSubjectRequest(TENANT_A, req.id, actor)
    expect(result.request.status).toBe("completed")
    expect(result.exportData).toBeDefined()
  })
})

describe("retention conflict vs legal hold in the plan", () => {
  // Resolve the recruitment candidate location to real, matching rows.
  function driveRecruitLocation(matches: number) {
    deps.tableColumns.mockImplementation(async (t: string) =>
      t === "recruit_candidates"
        ? new Set(["tenant_id", "email", "name", "phone"])
        : new Set<string>(),
    )
    db.custom = (sql) => {
      if (/COUNT\(\*\).*recruit_candidates/is.test(sql)) return [{ n: matches }]
      return undefined
    }
  }

  it("downgrades an erase to anonymize when an active retention policy governs the rows", async () => {
    driveRecruitLocation(3)
    deps.listPolicies.mockResolvedValue([{ catalogKey: "recruitment.candidates", status: "active" }])
    const { plan } = await planSubjectRequest(TENANT_A, "erase", "cand@example.com")
    db.custom = null
    expect(plan.hasRetentionConflict).toBe(true)
    expect(plan.anonymizeLocations.map((l) => l.key)).toContain("recruitment.candidates")
    expect(plan.eraseLocations.map((l) => l.key)).not.toContain("recruitment.candidates")
  })

  it("a legal hold blocks the location entirely", async () => {
    driveRecruitLocation(3)
    deps.getPolicyHoldCoverage.mockResolvedValue({ fullyHeld: true, holdNames: ["Case-1"], recordRefs: [], criteria: [] })
    const { plan } = await planSubjectRequest(TENANT_A, "erase", "held@example.com")
    db.custom = null
    expect(plan.hasLegalHoldConflict).toBe(true)
    expect(plan.blockedLocations.map((l) => l.key)).toContain("recruitment.candidates")
  })
})

describe("cross-tenant isolation", () => {
  it("a request created for one tenant is not readable by another", async () => {
    const req = await createSubjectRequest(TENANT_A, { kind: "export", subjectEmail: "priv@example.com" }, actor)
    expect(await getSubjectRequest(TENANT_B, req.id)).toBeNull()
    expect(await getSubjectRequest(TENANT_A, req.id)).not.toBeNull()
  })
})
