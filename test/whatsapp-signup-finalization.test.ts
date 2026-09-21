import { beforeEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ sql: vi.fn(), exchange: vi.fn(), save: vi.fn(), subscribe: vi.fn(), registration: vi.fn(), verify: vi.fn(), sync: vi.fn() }))
vi.mock("@/lib/db", () => ({ query: mock.sql }))
vi.mock("@/lib/tenant-scope", () => ({ currentTenantId: () => 7, currentTenantIdOrNull: () => 7, runForTenant: async (_: any, fn: any) => fn() }))
vi.mock("@/lib/whatsapp-registration", () => ({
  ensureRegistrationSchema: async () => {}, withWhatsAppLock: async (_: string, fn: any) => fn(),
  finalizeWhatsAppRegistration: mock.registration, readMetaRegistration: mock.registration,
}))
vi.mock("@/lib/whatsapp", () => ({
  GRAPH_VERSION: "v26.0", getAppId: () => "123", exchangeEmbeddedSignupCode: mock.exchange,
  verifyWhatsAppCredentials: mock.verify, getWabaName: async () => "Existing business", upsertWhatsAppIntegration: mock.save,
  subscribeWabaWebhook: mock.subscribe, getWabaSubscriptionStatus: async () => ({ ok: true, subscribed: true }),
  getWhatsAppIntegration: vi.fn(), toPublicIntegration: (row: any) => ({ id: row.id, phoneNumberId: row.phone_number_id }),
}))
vi.mock("@/lib/whatsapp-templates", () => ({ syncTemplatesFromMeta: mock.sync }))
import { handleWhatsAppSignupCallback } from "@/lib/whatsapp-signup"
import { encryptToken } from "@/lib/token-crypto"
let session: any, progress: any
const input = { state: "opaque-test-state", code: "test-authorization", wabaId: "100", phoneNumberId: "200", expectedTenantId: 7, expectedUserId: 5 }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "test-only")
  session = { id: 2, tenant_id: 7, user_id: 5, status: "pending", expires_at: "2099-01-01", waba_id: "100", phone_number_id: "200" }
  progress = null
  mock.exchange.mockResolvedValue({ ok: true, accessToken: "test-token" })
  mock.verify.mockResolvedValue({ displayPhoneNumber: "+910000000000", verifiedName: "Test", qualityRating: "GREEN", platformType: "CLOUD_API" })
  mock.registration.mockResolvedValue({ cloudApiRegistered: true, status: "registered" })
  mock.sync.mockResolvedValue({ ok: true, total: 1 })
  mock.sql.mockImplementation(async (sql: string, args: any[]) => {
    if (sql.startsWith("SELECT * FROM `marketing_whatsapp_signup_sessions`")) return [session]
    if (sql.includes("SELECT * FROM marketing_whatsapp_signup_progress")) return progress ? [progress] : []
    if (sql.includes("INSERT INTO marketing_whatsapp_signup_progress")) progress = { exchange_status: "exchanging" }
    if (sql.includes("exchange_status='exchanged'")) progress = { exchange_status: "exchanged", token_encrypted: args[0] }
    if (sql.includes("SELECT * FROM marketing_whatsapp_integration")) return [{ id: 4, tenant_id: 7, phone_number_id: "200", waba_id: "100" }]
    if (sql.startsWith("UPDATE `marketing_whatsapp_signup_sessions`")) session.status = args[0]
    return []
  })
})
describe("Embedded Signup durable finalization", () => {
  it("preserves the signup flow and finalizes the exact tenant connection", async () => {
    const result = await handleWhatsAppSignupCallback(input)
    expect(result.ok).toBe(true)
    expect(mock.registration).toHaveBeenCalledWith(7, 4)
    expect(mock.save).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "200", wabaId: "100", accessToken: "test-token" }))
    expect(mock.subscribe).not.toHaveBeenCalled() // already subscribed
    expect(mock.sync).toHaveBeenCalled()
  })
  it("duplicate callback returns the existing connection without exchanging code again", async () => {
    await handleWhatsAppSignupCallback(input)
    const repeated = await handleWhatsAppSignupCallback(input)
    expect(repeated.ok).toBe(true)
    expect(mock.exchange).toHaveBeenCalledTimes(1)
    expect(mock.save).toHaveBeenCalledTimes(1)
  })
  it("reuses a durably saved exchange token after interruption", async () => {
    progress = { exchange_status: "exchanged", token_encrypted: encryptToken("resumable-token") }
    expect((await handleWhatsAppSignupCallback(input)).ok).toBe(true)
    expect(mock.exchange).not.toHaveBeenCalled()
  })
  it("does not blindly reuse an authorization code after an uncertain exchange", async () => {
    progress = { exchange_status: "exchanging" }
    expect((await handleWhatsAppSignupCallback(input)).ok).toBe(false)
    expect(mock.exchange).not.toHaveBeenCalled()
  })
  it.each([{ expectedTenantId: 8 }, { expectedUserId: 9 }])("rejects foreign signup ownership %j", async change => {
    expect((await handleWhatsAppSignupCallback({ ...input, ...change })).ok).toBe(false)
    expect(mock.exchange).not.toHaveBeenCalled()
    expect(mock.save).not.toHaveBeenCalled()
  })
  it("registration failure retains the saved integration for retry", async () => {
    mock.registration.mockResolvedValue({ cloudApiRegistered: false, status: "failed", errorCode: "190" })
    const result = await handleWhatsAppSignupCallback(input)
    expect(result.ok).toBe(true)
    expect(result.integration?.id).toBe(4)
    expect(result.registration?.status).toBe("failed")
  })
  it("rejects changed identifiers on duplicate callback", async () => {
    session.status = "completed"
    expect((await handleWhatsAppSignupCallback({ ...input, phoneNumberId: "999" })).ok).toBe(false)
    expect(mock.registration).not.toHaveBeenCalled()
  })
})
