import { describe, expect, it } from "vitest"
import { fingerprintOf, redact, redactString, requestReference, safeDbError } from "@/lib/system-monitoring-core"

describe("system monitoring safety", () => {
  it("redacts nested credentials and common key variants", () => {
    const value = { password: "p-secret", access_token: "t-secret", rawBody: "raw-private", sql: "sql-private", nested: { accessToken: "a-secret", refreshToken: "r-secret", authorization: "Bearer abcdef", cookie: "session-secret", client_secret: "c-secret", app_secret: "s-secret", otp: "123456", other: "ok" } }
    const encoded = JSON.stringify(redact(value))
    for (const secret of ["p-secret", "t-secret", "raw-private", "sql-private", "a-secret", "r-secret", "abcdef", "session-secret", "c-secret", "s-secret", "123456"]) expect(encoded).not.toContain(secret)
    expect(encoded).toContain("ok")
  })

  it("redacts credentials embedded in messages and signed URLs", () => {
    const text = redactString("Authorization=Bearer xyz access_token=supersecret password=hunter2 https://example.test/x?code=abc123&api_key=key123 4111111111111111")
    for (const value of ["xyz", "supersecret", "hunter2", "abc123", "key123", "4111111111111111"]) expect(text).not.toContain(value)
  })

  it("does not copy raw SQL or parameters from database errors", () => {
    const error = Object.assign(new Error("token leaked"), { code: "ER_DUP_ENTRY", sqlState: "23000", sql: "INSERT token leaked", sqlMessage: "Duplicate token leaked" })
    expect(safeDbError(error)).toEqual({ databaseErrorCode: "ER_DUP_ENTRY", sqlState: "23000" })
    expect(JSON.stringify(safeDbError(error))).not.toContain("leaked")
  })

  it("normalizes dynamic IDs when fingerprinting recurring incidents", () => {
    const one = fingerprintOf({ environment: "production", service: "api", operation: "login", message: "User 123 failed" })
    const two = fingerprintOf({ environment: "production", service: "api", operation: "login", message: "User 456 failed" })
    const different = fingerprintOf({ environment: "staging", service: "api", operation: "login", message: "User 456 failed" })
    expect(one).toBe(two)
    expect(one).not.toBe(different)
  })

  it("only accepts bounded safe request IDs", () => {
    expect(requestReference("req_abc-123")).toBe("req_abc-123")
    expect(requestReference("Bearer secret value")).toMatch(/^req_[0-9a-f-]+$/)
  })
})
