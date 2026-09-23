import { beforeEach, expect, it, vi } from "vitest"
const db = vi.hoisted(() => ({ query: vi.fn(), connQuery: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }))
const dep = vi.hoisted(() => ({ tenant: vi.fn(), create: vi.fn(), callback: vi.fn(), audit: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: db.query, pool: { getConnection: async () => ({ query: db.connQuery, beginTransaction: db.begin, commit: db.commit, rollback: db.rollback, release: db.release }) } }))
vi.mock("@/lib/tenant-service", () => ({ getTenantById: dep.tenant }))
vi.mock("@/lib/tenant-scope", () => ({ runForTenant: (_scope: unknown, fn: () => unknown) => fn() }))
vi.mock("@/lib/whatsapp-signup", () => ({ createWhatsAppSignupSession: dep.create, handleWhatsAppSignupCallback: dep.callback }))
vi.mock("@/lib/mobile-auth", () => ({ auditMobileAction: dep.audit }))
import { createMobileOnboarding, finishMobileSignup, launchMobileSignup } from "@/lib/mobile-whatsapp-onboarding"

const principal = { userId: 5, tenantId: 7, name: "Owner", email: "owner@example.com", role: "admin" as const, tenantRole: "tenant_owner", sessionId: "mobile-session" }
const launchRow = { id: 12, tenant_id: 7, user_id: 5, mobile_session_id: "mobile-session", status: "pending", signup_state: null, expires_at: "2099-01-01" }
beforeEach(() => {
  vi.clearAllMocks()
  process.env.APP_URL = "https://erp.example.test"
  dep.tenant.mockResolvedValue({ id: 7, tenant_type: "SHOPKEEPER", status: "active" })
  dep.create.mockResolvedValue({ state: "trusted-state", appId: "public-app", configId: "public-config", graphVersion: "v26.0", ready: true })
  dep.callback.mockResolvedValue({ ok: true, registration: { cloudApiRegistered: true }, autoConfig: { webhookSubscribed: true } })
  db.query.mockImplementation(async (sql: string) => sql.includes("SELECT l.*") ? [launchRow] : { affectedRows: 1 })
  db.connQuery.mockImplementation(async (sql: string) => sql.includes("FOR UPDATE") ? [[launchRow]] : [{ affectedRows: 1 }])
})

it("issues only a short-lived opaque link bound to the authenticated owner", async () => {
  const result = await createMobileOnboarding(principal)
  expect(result.url).toMatch(/^https:\/\/erp\.example\.test\/mobile\/whatsapp\/connect#session=/)
  expect(result.url).not.toContain("tenantId")
  expect(db.query.mock.calls.some(([sql, params]) => String(sql).includes("INSERT INTO mobile_whatsapp_onboarding") && params.includes(7) && params.includes("mobile-session"))).toBe(true)
})
it("denies suspended, pending, and unauthorized users before issuing any link", async () => {
  dep.tenant.mockResolvedValue({ id: 7, tenant_type: "SHOPKEEPER", status: "suspended" })
  await expect(createMobileOnboarding(principal)).rejects.toMatchObject({ status: 403 })
  dep.tenant.mockResolvedValue({ id: 7, tenant_type: "SHOPKEEPER", status: "active" })
  await expect(createMobileOnboarding({ ...principal, role: "employee", tenantRole: "employee" })).rejects.toMatchObject({ status: 403 })
})
it("rejects an expired/revoked launch token", async () => {
  db.query.mockImplementation(async (sql: string) => sql.includes("SELECT l.*") ? [] : {})
  await expect(launchMobileSignup("A".repeat(43))).rejects.toMatchObject({ status: 410 })
  expect(dep.create).not.toHaveBeenCalled()
})
it("consumes a launch only once and reuses the existing Meta signup session", async () => {
  await launchMobileSignup("A".repeat(43))
  expect(dep.create).toHaveBeenCalledWith(5)
  expect(db.connQuery).toHaveBeenCalledWith(expect.stringContaining("status='started'"), ["trusted-state", 12])
  expect(db.commit).toHaveBeenCalled()
  db.query.mockImplementation(async (sql: string) => sql.includes("SELECT l.*") ? [{ ...launchRow, status: "started" }] : {})
  await expect(launchMobileSignup("A".repeat(43))).rejects.toMatchObject({ status: 409 })
})
it("rejects state substitution before Meta exchange", async () => {
  db.query.mockImplementation(async (sql: string) => sql.includes("SELECT l.*") ? [{ ...launchRow, status: "started", signup_state: "trusted-state" }] : {})
  await expect(finishMobileSignup({ launchToken: "A".repeat(43), state: "other-state", code: "code", wabaId: "123", phoneNumberId: "456" })).rejects.toMatchObject({ status: 409 })
  expect(dep.callback).not.toHaveBeenCalled()
})
it("passes server-bound tenant/user to the existing code exchange and returns no credentials", async () => {
  db.query.mockImplementation(async (sql: string) => sql.includes("SELECT l.*") ? [{ ...launchRow, status: "started", signup_state: "trusted-state" }] : { affectedRows: 1 })
  const result = await finishMobileSignup({ launchToken: "A".repeat(43), state: "trusted-state", code: "secret-code", wabaId: "123", phoneNumberId: "456" })
  expect(dep.callback).toHaveBeenCalledWith(expect.objectContaining({ expectedTenantId: 7, expectedUserId: 5, wabaId: "123", phoneNumberId: "456" }))
  expect(result).toEqual({ connected: true, messagingReady: true, webhookSubscribed: true })
  expect(JSON.stringify(result)).not.toContain("secret-code")
})
