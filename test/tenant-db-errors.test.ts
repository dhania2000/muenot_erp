import { describe, expect, it } from "vitest"
import { classifyTenantDbFailure } from "@/lib/tenant-db/errors"

describe("tenant database error sanitization", () => {
  it.each([
    ["ER_ACCESS_DENIED_ERROR", "AUTH_FAILED"],
    ["ER_BAD_DB_ERROR", "DATABASE_NOT_FOUND"],
    ["ER_TABLEACCESS_DENIED_ERROR", "INSUFFICIENT_PRIVILEGES"],
    ["ETIMEDOUT", "TIMEOUT"],
    ["ECONNREFUSED", "NETWORK_FAILED"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_FAILED"],
  ])("maps %s to a safe %s code", (dbCode, expected) => {
    const failure = classifyTenantDbFailure({ code: dbCode, message: "password=do-not-log host=private.internal" })
    expect(failure.code).toBe(expected)
    expect(JSON.stringify(failure)).not.toContain("do-not-log")
    expect(JSON.stringify(failure)).not.toContain("private.internal")
  })

  it("never echoes unknown driver messages", () => {
    const failure = classifyTenantDbFailure(new Error("mysql://root:secret@127.0.0.1/db"))
    expect(failure).toEqual({ code: "UNKNOWN_ERROR", message: "Database operation failed." })
  })
})
