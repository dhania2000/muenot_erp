import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Organization onboarding — resumable, validated, idempotent finalize.
 * ---------------------------------------------------------------------------
 * Covers the enterprise onboarding orchestrator's guarantees:
 *   - a partial draft is saved step-by-step and only validated at finalize,
 *   - finalize is idempotent: a completed record returns its existing ids
 *     without re-provisioning,
 *   - a failure mid-finalize records the partial progress so a RETRY resumes
 *     (skips the already-created tenant, only creates the missing admin),
 *   - a duplicate admin email is rejected (409) and the run is marked failed,
 *   - a completed onboarding is immutable (no further step edits).
 *
 * The DB (`query`/`pool`), tenant provisioning, password hashing, and audit
 * are mocked so the test asserts the orchestrator's decisions.
 */

const query = vi.fn((..._args: any[]) => undefined as any)
const getConnection = vi.fn((..._args: any[]) => undefined as any)
const createTenant = vi.fn((..._args: any[]) => undefined as any)
const getTenantBySlug = vi.fn((..._args: any[]) => undefined as any)
const hashPassword = vi.fn(async (..._args: any[]) => "hashed")
const generateTempPassword = vi.fn((..._args: any[]) => "Temp-Passw0rd")
const recordPlatformAudit = vi.fn(async (..._args: any[]) => {})

vi.mock("@/lib/db", () => ({
  query: (...a: any[]) => query(...a),
  pool: { getConnection: (...a: any[]) => getConnection(...a) },
}))
vi.mock("@/lib/tenant-service", () => ({
  createTenant: (...a: any[]) => createTenant(...a),
  getTenantBySlug: (...a: any[]) => getTenantBySlug(...a),
}))
vi.mock("@/lib/password", () => ({
  hashPassword: (...a: any[]) => hashPassword(...a),
  generateTempPassword: (...a: any[]) => generateTempPassword(...a),
}))
vi.mock("@/lib/platform-roles", () => ({
  recordPlatformAudit: (...a: any[]) => recordPlatformAudit(...a),
}))

import {
  validateOnboarding,
  finalizeOnboarding,
  saveOnboardingStep,
  OnboardingStateError,
  OnboardingValidationError,
  type OnboardingData,
  type OnboardingRecord,
} from "@/lib/tenant-onboarding"

const VALID_DATA: OnboardingData = {
  companyName: "Acme Corp",
  legalEntity: "Acme Corp Pvt Ltd",
  industry: "Manufacturing",
  companySize: "51-200",
  country: "US",
  currency: "USD",
  timezone: "America/New_York",
  fiscalYearStart: "January",
  language: "en",
  adminName: "Ada Owner",
  adminEmail: "ada@acme.test",
  slug: "acme",
  plan: "growth",
  deploymentModel: "shared_database",
}

function record(overrides: Partial<OnboardingRecord> = {}): OnboardingRecord {
  return {
    id: 1,
    status: "in_progress",
    currentStep: 7,
    data: VALID_DATA,
    createdTenantId: null,
    createdAdminUserId: null,
    errorMessage: null,
    createdBy: 5,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    completedAt: null,
    ...overrides,
  }
}

/** Turn an OnboardingRecord back into the DB row shape getOnboarding reads. */
function row(rec: OnboardingRecord) {
  return {
    id: rec.id,
    status: rec.status,
    current_step: rec.currentStep,
    data: JSON.stringify(rec.data),
    created_tenant_id: rec.createdTenantId,
    created_admin_user_id: rec.createdAdminUserId,
    error_message: rec.errorMessage,
    created_by: rec.createdBy,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    completed_at: rec.completedAt,
  }
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()
const findCall = (needle: string) => query.mock.calls.find(([sql]) => norm(sql).includes(needle))

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue([])
  createTenant.mockReset()
  getTenantBySlug.mockReset()
  getConnection.mockReset()
  recordPlatformAudit.mockReset()
  hashPassword.mockResolvedValue("hashed")
  generateTempPassword.mockReturnValue("Temp-Passw0rd")
})

afterEach(() => {
  vi.clearAllMocks()
})

/** A fake transactional connection for the admin-user INSERT step. */
function fakeConn(insertId = 42) {
  return {
    beginTransaction: vi.fn(async () => {}),
    query: vi.fn(async (_sql?: string, _params?: unknown[]) => [{ insertId }]),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(() => {}),
  }
}

describe("validateOnboarding (validation before provisioning)", () => {
  it("passes on a complete, valid draft", () => {
    expect(validateOnboarding(VALID_DATA)).toEqual([])
  })

  it("flags every missing required field on a partial signup", () => {
    const errors = validateOnboarding({ companyName: "Acme" })
    const fields = errors.map((e) => e.field)
    expect(fields).toContain("adminEmail")
    expect(fields).toContain("slug")
    expect(fields).toContain("plan")
    expect(fields).not.toContain("companyName")
  })

  it("rejects a malformed admin email and slug (role/identity boundaries)", () => {
    const errors = validateOnboarding({ ...VALID_DATA, adminEmail: "not-an-email", slug: "Bad Slug!" })
    expect(errors.some((e) => e.field === "adminEmail")).toBe(true)
    expect(errors.some((e) => e.field === "slug")).toBe(true)
  })
})

describe("saveOnboardingStep (resumable draft)", () => {
  it("merges the step patch and advances the furthest step reached", async () => {
    // getOnboarding read → return an early in-progress draft.
    query.mockImplementation(async (sql: string) => {
      if (norm(sql).includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) {
        return [row(record({ currentStep: 1, data: { companyName: "Acme Corp" } }))]
      }
      return []
    })
    await saveOnboardingStep(1, 2, { industry: "Manufacturing" })
    const update = findCall("UPDATE `tenant_onboarding` SET `data`")
    expect(update).toBeTruthy()
    // Merged payload keeps the prior field and adds the new one.
    const savedJson = update![1][0]
    expect(savedJson).toContain("Acme Corp")
    expect(savedJson).toContain("Manufacturing")
  })

  it("refuses to edit a completed onboarding (immutability)", async () => {
    query.mockImplementation(async (sql: string) => {
      if (norm(sql).includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) {
        return [row(record({ status: "completed" }))]
      }
      return []
    })
    await expect(saveOnboardingStep(1, 3, { industry: "X" })).rejects.toBeInstanceOf(OnboardingStateError)
  })
})

describe("finalizeOnboarding (idempotent, resumable provisioning)", () => {
  it("rejects an incomplete draft with a field-level validation error", async () => {
    query.mockImplementation(async (sql: string) => {
      if (norm(sql).includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) {
        return [row(record({ data: { companyName: "Acme" } }))]
      }
      return []
    })
    await expect(finalizeOnboarding(1, { userId: 5 })).rejects.toBeInstanceOf(OnboardingValidationError)
    // A tenant is never provisioned for an invalid draft.
    expect(createTenant).not.toHaveBeenCalled()
  })

  it("provisions the tenant + first owner and marks completed on a clean run", async () => {
    getTenantBySlug.mockResolvedValue(null)
    createTenant.mockResolvedValue({ id: 100, slug: "acme" })
    const conn = fakeConn(42)
    getConnection.mockResolvedValue(conn)
    query.mockImplementation(async (sql: string) => {
      const s = norm(sql)
      if (s.includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) return [row(record())]
      if (s.includes("SELECT id FROM users WHERE email")) return [] // no duplicate
      return []
    })

    const result = await finalizeOnboarding(1, { userId: 5, email: "actor@acme.test" })

    expect(createTenant).toHaveBeenCalledOnce()
    expect(result.tenantId).toBe(100)
    expect(result.adminUserId).toBe(42)
    expect(result.adminTempPassword).toBe("Temp-Passw0rd")
    // First user is seeded as tenant_owner.
    const insert = conn.query.mock.calls.find(([sql]) => norm(sql ?? "").includes("INSERT INTO users"))
    expect(norm(insert?.[0] ?? "")).toContain("tenant_owner")
    expect(conn.commit).toHaveBeenCalledOnce()
    expect(findCall("SET `status` = 'completed'")).toBeTruthy()
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "onboard_tenant", targetTenantId: 100, targetUserId: 42 }),
    )
  })

  it("is idempotent: a completed record returns existing ids without re-provisioning", async () => {
    query.mockImplementation(async (sql: string) => {
      if (norm(sql).includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) {
        return [row(record({ status: "completed", createdTenantId: 100, createdAdminUserId: 42 }))]
      }
      return []
    })
    const result = await finalizeOnboarding(1, { userId: 5 })
    expect(result).toMatchObject({ tenantId: 100, adminUserId: 42, adminTempPassword: null })
    expect(createTenant).not.toHaveBeenCalled()
    expect(getConnection).not.toHaveBeenCalled()
  })

  it("resumes after a failure: skips the already-created tenant, only creates the missing admin", async () => {
    // Prior run created the tenant (id 100) but failed before the admin user.
    const conn = fakeConn(43)
    getConnection.mockResolvedValue(conn)
    query.mockImplementation(async (sql: string) => {
      const s = norm(sql)
      if (s.includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) {
        return [row(record({ status: "failed", createdTenantId: 100, createdAdminUserId: null }))]
      }
      if (s.includes("SELECT id FROM users WHERE email")) return []
      return []
    })

    const result = await finalizeOnboarding(1, { userId: 5 })

    // Tenant already existed → not re-created.
    expect(createTenant).not.toHaveBeenCalled()
    expect(getTenantBySlug).not.toHaveBeenCalled()
    // Missing admin is created on the retry.
    expect(result.tenantId).toBe(100)
    expect(result.adminUserId).toBe(43)
    expect(findCall("SET `status` = 'completed'")).toBeTruthy()
  })

  it("rejects a duplicate admin email (409) and records the failure for retry", async () => {
    getTenantBySlug.mockResolvedValue(null)
    createTenant.mockResolvedValue({ id: 100, slug: "acme" })
    query.mockImplementation(async (sql: string) => {
      const s = norm(sql)
      if (s.includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) return [row(record())]
      if (s.includes("SELECT id FROM users WHERE email")) return [{ id: 999 }] // duplicate!
      return []
    })

    await expect(finalizeOnboarding(1, { userId: 5 })).rejects.toMatchObject({ status: 409 })
    // The failure is persisted so the run can be retried after fixing the email.
    expect(findCall("SET `status` = 'failed'")).toBeTruthy()
    expect(getConnection).not.toHaveBeenCalled()
  })

  it("rejects when the tenant slug is already taken (409)", async () => {
    getTenantBySlug.mockResolvedValue({ id: 7, slug: "acme" })
    query.mockImplementation(async (sql: string) => {
      if (norm(sql).includes("SELECT * FROM `tenant_onboarding` WHERE `id`")) return [row(record())]
      return []
    })
    await expect(finalizeOnboarding(1, { userId: 5 })).rejects.toMatchObject({ status: 409 })
    expect(createTenant).not.toHaveBeenCalled()
    expect(findCall("SET `status` = 'failed'")).toBeTruthy()
  })
})
