import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ query: vi.fn(), connQuery: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }))
const deps = vi.hoisted(() => ({ hashPassword: vi.fn(), provision: vi.fn(), audit: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: db.query, pool: { getConnection: async () => ({ query: db.connQuery, beginTransaction: db.begin, commit: db.commit, rollback: db.rollback, release: db.release }) }, withTransaction: vi.fn().mockRejectedValue(new Error("notifications unavailable")) }))
vi.mock("@/lib/password", () => ({ hashPassword: deps.hashPassword }))
vi.mock("@/lib/shopkeeper-provisioning", () => ({ ensureShopkeeperProvisioningSchema: vi.fn(), insertShopkeeperRecords: deps.provision, requireShopkeeperPlan: vi.fn().mockResolvedValue({ code: "shopkeeper", name: "Shopkeeper", is_active: true, price_monthly: 0, currency: "INR" }) }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: deps.audit }))
vi.mock("@/lib/notification-engine/schema", () => ({ ensureNotificationEngineSchema: vi.fn() }))
vi.mock("@/lib/notification-engine/service", () => ({ enqueueNotification: vi.fn(), processNotification: vi.fn() }))

import { approveApplication, getRegistrationStatus, registerShopkeeper, validatePublicRegistration } from "@/lib/shopkeeper-applications"

const input = { businessName: "Mubarik Bangles", businessCategory: "Bangles", ownerName: "Mubarik", email: " Owner@Example.com ", mobile: "+91 98765 43210", country: "IN", state: "Rajasthan", city: "Jaipur", postalCode: "302001", password: "Securepass123", termsAccepted: true, privacyAccepted: true }
beforeEach(() => {
  vi.clearAllMocks()
  db.rollback.mockResolvedValue(undefined)
  db.query.mockImplementation(async (sql: string) => sql.includes("SELECT id FROM users") ? [] : { affectedRows: 1 })
  db.connQuery.mockImplementation(async (sql: string) => sql.includes("INSERT INTO shopkeeper_applications") ? [{ insertId: 42 }] : [{ affectedRows: 1 }])
  deps.hashPassword.mockResolvedValue("$2b$hashed-only")
  deps.provision.mockResolvedValue({ tenantId: 9, ownerUserId: 10, slug: "mubarik-bangles", subscriptionStatus: "active", trialEnd: null })
})

describe("Shopkeeper public registration", () => {
  it("validates and normalizes without accepting privilege fields", () => {
    const malicious = { ...input, tenant_id: 999, role: "super_admin", status: "APPROVED" }
    const result = validatePublicRegistration(malicious)
    expect(result).toMatchObject({ email: "owner@example.com", mobile: "+919876543210", country: "IN" })
    expect(result).not.toHaveProperty("role")
    expect(result).not.toHaveProperty("tenant_id")
    expect(result).not.toHaveProperty("status")
  })
  it.each([
    [{ ...input, email: "bad" }, "email"],
    [{ ...input, password: "weak" }, "password"],
    [{ ...input, termsAccepted: false }, "termsAccepted"],
    [{ ...input, mobile: "123" }, "mobile"],
  ])("rejects invalid input", (value, field) => {
    expect(() => validatePublicRegistration(value)).toThrow()
    try { validatePublicRegistration(value) } catch (error) { expect(error).toMatchObject({ field }) }
  })
  it("stores only a hash, issues a receipt, and never creates an active tenant", async () => {
    const result = await registerShopkeeper(input)
    expect(result).toMatchObject({ applicationId: 42, status: "PENDING_APPROVAL" })
    expect(result.registrationToken.length).toBeGreaterThan(40)
    expect(deps.hashPassword).toHaveBeenCalledWith(input.password)
    const insert = db.connQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO shopkeeper_applications"))!
    expect(insert[1]).toContain("$2b$hashed-only")
    expect(insert[1]).not.toContain(input.password)
    expect(db.connQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tenants"))).toBe(false)
    expect(db.commit).toHaveBeenCalled()
  })
  it("rejects an existing identity", async () => {
    db.query.mockImplementation(async (sql: string) => sql.includes("SELECT id FROM users") ? [{ id: 8 }] : {})
    await expect(registerShopkeeper(input)).rejects.toMatchObject({ status: 409 })
    expect(db.connQuery).not.toHaveBeenCalled()
  })
  it("rolls back if the application event cannot be recorded", async () => {
    db.connQuery.mockImplementation(async (sql: string) => { if (sql.includes("shopkeeper_application_events")) throw new Error("database failed"); return [{ insertId: 42 }] })
    await expect(registerShopkeeper(input)).rejects.toThrow("database failed")
    expect(db.rollback).toHaveBeenCalled()
    expect(db.commit).not.toHaveBeenCalled()
  })
  it("returns only safe status fields to a registration receipt", async () => {
    db.query.mockResolvedValueOnce([{ id: 1, status: "REJECTED", business_name: "Shop", owner_name: "Owner", submitted_at: "2026-09-23", rejection_reason: "Please correct your address", password_hash: "hidden" }])
    const status = await getRegistrationStatus("A".repeat(43))
    expect(status).toMatchObject({ status: "REJECTED", rejectionReason: "Please correct your address" })
    expect(JSON.stringify(status)).not.toContain("hidden")
  })
  it("reports a suspended approved tenant as SUSPENDED", async () => {
    db.query.mockImplementation(async (sql: string) => sql.includes("FROM shopkeeper_applications")
      ? [{ id: 1, status: "APPROVED", tenant_id: 9, business_name: "Shop", owner_name: "Owner" }]
      : sql.includes("FROM tenants") ? [{ status: "suspended" }] : {})
    expect(await getRegistrationStatus("A".repeat(43))).toMatchObject({ status: "SUSPENDED" })
  })
})

describe("Platform approval", () => {
  it("locks the pending application and provisions with its existing hash", async () => {
    db.connQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM shopkeeper_applications")) return [[{ id: 42, status: "PENDING_APPROVAL", business_name: "Shop", business_category: "Retail", owner_name: "Owner", email: "owner@example.com", mobile: "+919876543210", country: "IN", state: "Rajasthan", city: "Jaipur", postal_code: "302001", password_hash: "$2b$stored", token_hash: "secret" }]]
      if (sql.includes("SELECT id FROM users")) return [[]]
      return [{ affectedRows: 1 }]
    })
    db.query.mockResolvedValue([{ id: 42, status: "APPROVED", business_name: "Shop" }])
    await approveApplication(42, "shopkeeper", false, { userId: 1 })
    expect(deps.provision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerEmail: "owner@example.com", password: null }), "$2b$stored", expect.anything(), expect.anything(), expect.objectContaining({ channel: "mobile_self_registration" }))
    expect(db.commit).toHaveBeenCalled()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "approve_shopkeeper_application", targetTenantId: 9 }))
  })
  it("rolls back every write when provisioning fails", async () => {
    db.connQuery.mockImplementation(async (sql: string) => sql.includes("SELECT * FROM shopkeeper_applications") ? [[{ id: 42, status: "PENDING_APPROVAL", email: "a@b.com", mobile: "+919876543210" }]] : [[]])
    deps.provision.mockRejectedValue(new Error("subscription unavailable"))
    await expect(approveApplication(42, "shopkeeper", false, { userId: 1 })).rejects.toThrow("subscription unavailable")
    expect(db.rollback).toHaveBeenCalled()
    expect(db.commit).not.toHaveBeenCalled()
  })
})
