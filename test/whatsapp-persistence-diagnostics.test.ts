import { describe, expect, it } from "vitest"
import { persistenceStep, safeWhatsAppPersistenceError, WhatsAppPersistenceError } from "@/lib/whatsapp-persistence-diagnostics"

describe("WhatsApp persistence diagnostics", () => {
  it("identifies the failing write without leaking values or SQL", async () => {
    const cause = Object.assign(new Error("private token"), {
      code: "ER_DUP_ENTRY", sqlState: "23000",
      sql: "INSERT INTO marketing_whatsapp_integration VALUES ('private token')",
      sqlMessage: "Duplicate entry 'private token' for key 'uniq_wa_integration_tenant_phone'",
    })
    await expect(persistenceStep("integration_upsert", () => { throw cause })).rejects.toBeInstanceOf(WhatsAppPersistenceError)
    try { await persistenceStep("integration_upsert", () => { throw cause }) } catch (error) {
      const safe = safeWhatsAppPersistenceError(error)
      expect(safe).toMatchObject({ operation: "integration_upsert", databaseErrorCode: "ER_DUP_ENTRY",
        sqlState: "23000", constraint: "uniq_wa_integration_tenant_phone" })
      expect(JSON.stringify(safe)).not.toContain("private token")
      expect(JSON.stringify(safe)).not.toContain("INSERT INTO")
    }
  })

  it("identifies schema, size and encryption failures safely", () => {
    expect(safeWhatsAppPersistenceError(new WhatsAppPersistenceError("integration_upsert", {
      code: "ER_BAD_FIELD_ERROR", sqlState: "42S22", sqlMessage: "Unknown column 'business_id' in 'field list'",
    }))).toMatchObject({ column: "business_id", databaseErrorCode: "ER_BAD_FIELD_ERROR" })
    expect(safeWhatsAppPersistenceError(new WhatsAppPersistenceError("integration_upsert", {
      code: "ER_DATA_TOO_LONG", sqlState: "22001", sqlMessage: "Data too long for column 'access_token'",
    }))).toMatchObject({ column: "access_token", databaseErrorCode: "ER_DATA_TOO_LONG" })
    expect(safeWhatsAppPersistenceError(new WhatsAppPersistenceError("token_encryption", new Error("secret material"))).sanitizedMessage)
      .toBe("Credential encryption failed.")
  })
})
