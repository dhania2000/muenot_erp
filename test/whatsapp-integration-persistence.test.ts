import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ query: vi.fn(), tenantId: 177, foreign: false, failUpsert: false }))
vi.mock("@/lib/db", () => ({ query: mock.query }))
vi.mock("@/lib/tenant-scope", () => ({ currentTenantId: () => mock.tenantId, currentTenantIdOrNull: () => mock.tenantId }))
vi.mock("@/lib/whatsapp-registration", () => ({ withWhatsAppLock: async (_key: string, fn: () => Promise<unknown>) => fn() }))
import { upsertWhatsAppIntegration } from "@/lib/whatsapp"
import { safeWhatsAppPersistenceError } from "@/lib/whatsapp-persistence-diagnostics"
import { decryptToken } from "@/lib/token-crypto"

const connection = {
  wabaId: "100", phoneNumberId: "200", displayPhoneNumber: null, verifiedName: null,
  businessName: null, businessId: null, qualityRating: null, platformType: null,
  accessToken: "test-only-token", connectedByUserId: 10,
}

beforeEach(() => {
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "test-only-key")
  mock.query.mockReset()
  mock.tenantId = 177; mock.foreign = false; mock.failUpsert = false
  mock.query.mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema")) return [{ c: 1 }]
    if (sql.includes("SELECT tenant_id FROM marketing_whatsapp_integration")) return mock.foreign ? [{ tenant_id: 999 }] : []
    if (sql.includes("INSERT INTO `marketing_whatsapp_integration`") && mock.failUpsert)
      throw Object.assign(new Error("sensitive token"), { code: "ER_BAD_FIELD_ERROR", sqlState: "42S22", sqlMessage: "Unknown column 'business_id' in 'field list'" })
    return []
  })
})

describe("tenant-scoped WhatsApp connection persistence", () => {
  it("saves a fresh tenant connection with discovered IDs and an encrypted token", async () => {
    await upsertWhatsAppIntegration(connection)
    const write = mock.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO `marketing_whatsapp_integration`"))
    expect(write).toBeDefined()
    expect(write![1]).toEqual([177, "100", "200", null, null, null, null, null, null, expect.stringMatching(/^enc:v1:/), 10])
    expect(write![1]).not.toContain(undefined)
    expect(write![1][9]).not.toContain("test-only-token")
  })

  it("uses the same tenant-scoped upsert for reconnect/retry, not a second insert path", async () => {
    await upsertWhatsAppIntegration(connection)
    await upsertWhatsAppIntegration({ ...connection, accessToken: "rotated-test-token" })
    const writes = mock.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO `marketing_whatsapp_integration`"))
    expect(writes).toHaveLength(2)
    expect(writes.every(([sql]) => sql.includes("ON DUPLICATE KEY UPDATE"))).toBe(true)
    expect(decryptToken(writes[1][1][9])).toBe("rotated-test-token")
    expect(writes[1][1][9]).not.toBe(writes[0][1][9])
  })

  it("rejects a number already owned by another tenant", async () => {
    mock.foreign = true
    await expect(upsertWhatsAppIntegration(connection)).rejects.toThrow("another workspace")
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO `marketing_whatsapp_integration`"))).toBe(false)
  })

  it("only checks unreleased ownership, allowing an explicitly released number to connect elsewhere", async () => {
    await upsertWhatsAppIntegration(connection)
    const check = mock.query.mock.calls.find(([sql]) => sql.includes("SELECT tenant_id FROM marketing_whatsapp_integration"))
    expect(check?.[0]).toContain("released_at IS NULL")
    expect(check?.[0]).toContain("tenant_id IS NULL OR tenant_id<>?")
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO `marketing_whatsapp_integration`"))).toBe(true)
  })

  it("preserves safe SQL error metadata for the actual failing upsert", async () => {
    mock.failUpsert = true
    try { await upsertWhatsAppIntegration(connection); throw new Error("expected failure") }
    catch (error) {
      const safe = safeWhatsAppPersistenceError(error)
      expect(safe).toMatchObject({ operation: "integration_upsert", databaseErrorCode: "ER_BAD_FIELD_ERROR", column: "business_id", sqlState: "42S22" })
      expect(JSON.stringify(safe)).not.toContain("sensitive token")
    }
  })
})
