import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ sql: vi.fn(), lock: vi.fn(), release: vi.fn(), integration: vi.fn(), fetch: vi.fn() }))
vi.mock("@/lib/db", () => ({ query: mock.sql, pool: { getConnection: async () => ({ query: mock.lock, release: mock.release }) } }))
vi.mock("mysql2/promise", () => ({ default: { createConnection: async () => ({ query: mock.lock, end: mock.release }) } }))
vi.mock("@/lib/whatsapp", () => ({ GRAPH_VERSION: "v26.0", getWhatsAppIntegrationByIdForTenant: mock.integration }))
import { finalizeWhatsAppRegistration, readMetaRegistration } from "@/lib/whatsapp-registration"
import { encryptToken, decryptToken } from "@/lib/token-crypto"

let row: any, status: string | undefined, savedPin: string | null, fail: string | undefined, posts: number
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "unit-test-encryption-key")
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "global-never-use")
  vi.stubEnv("WHATSAPP_WABA_ID", "global-never-use")
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {})
  row = { id: 4, tenant_id: 7, waba_id: "100", phone_number_id: "200", access_token: encryptToken("tenant-seven-token") }
  status = "PENDING"; savedPin = null; fail = undefined; posts = 0
  mock.lock.mockResolvedValue([[{ acquired: 1 }]])
  mock.integration.mockImplementation(async (id, tenant) => id === row.id && tenant === row.tenant_id ? row : null)
  mock.sql.mockImplementation(async (sql: string, args: any[]) => {
    if (sql.includes("SELECT pin_encrypted")) return [{ pin_encrypted: savedPin }]
    if (sql.includes("SET pin_encrypted")) savedPin = args[0]
    return []
  })
  mock.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (fail === "auth") return new Response(JSON.stringify({ error: { code: 190, message: "unsafe tenant-seven-token 123456" } }), { status: 401 })
    if (url.includes("/phone_numbers")) return ok({ data: [{ id: row.phone_number_id }] })
    if (url.includes("display_phone_number")) return ok({ display_phone_number: "+910000000000", verified_name: "Test", quality_rating: "GREEN" })
    if (options.method === "POST") {
      posts++
      if (fail === "timeout") throw new DOMException("private token", "TimeoutError")
      if (fail === "pin") return new Response(JSON.stringify({ error: { code: 133005, error_subcode: 9, message: "unsafe tenant-seven-token 123456" } }), { status: 400 })
      if (fail !== "pending") status = "CONNECTED"
      return ok({ success: true })
    }
    return ok({ status, platform_type: "CLOUD_API" })
  })
  vi.stubGlobal("fetch", mock.fetch)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("tenant-owned Cloud API registration", () => {
  it("registers a new phone with an encrypted, connection-specific PIN then verifies Meta", async () => {
    const result = await finalizeWhatsAppRegistration(7, 4)
    expect(result.cloudApiRegistered).toBe(true)
    const [url, request] = mock.fetch.mock.calls.find(([, request]) => request.method === "POST")!
    expect(url).toBe("https://graph.facebook.com/v26.0/200/register")
    expect(request.headers.Authorization).toBe("Bearer tenant-seven-token")
    expect(JSON.parse(request.body)).toEqual({ messaging_product: "whatsapp", pin: expect.stringMatching(/^\d{6}$/) })
    expect(savedPin).toMatch(/^enc:v1:/)
    expect(decryptToken(savedPin)).toBe(JSON.parse(request.body).pin)
    expect(JSON.stringify(result)).not.toContain("pin")
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("SET display_phone_number"), ["+910000000000", "Test", "GREEN", 7, 4])
  })
  it("does not register an already registered phone", async () => {
    status = "CONNECTED"
    expect((await finalizeWhatsAppRegistration(7, 4)).cloudApiRegistered).toBe(true)
    expect(posts).toBe(0)
  })
  it("duplicate finalization does not duplicate registration", async () => {
    await finalizeWhatsAppRegistration(7, 4)
    await finalizeWhatsAppRegistration(7, 4)
    expect(posts).toBe(1)
  })
  it("a competing worker cannot register while the connection lock is held", async () => {
    mock.lock.mockResolvedValue([[{ acquired: 0 }]])
    await expect(finalizeWhatsAppRegistration(7, 4)).rejects.toThrow("already running")
    expect(mock.fetch).not.toHaveBeenCalled()
    expect(mock.release).toHaveBeenCalled()
  })
  it("does not mistake POST acceptance for messaging readiness", async () => {
    fail = "pending"
    expect((await finalizeWhatsAppRegistration(7, 4)).cloudApiRegistered).toBe(false)
  })
  it("does not register when Meta cannot establish the current registration status", async () => {
    status = undefined
    expect((await finalizeWhatsAppRegistration(7, 4)).status).toBe("unconfirmed")
    expect(posts).toBe(0)
  })
  it("does not auto-register an on-premise number", async () => {
    const implementation = mock.fetch.getMockImplementation()!
    mock.fetch.mockImplementation((url, options) => url.includes("?fields=status") ? ok({ status: "CONNECTED", platform_type: "ON_PREMISE" }) : implementation(url, options))
    expect((await finalizeWhatsAppRegistration(7, 4)).status).toBe("migration_required")
    expect(posts).toBe(0)
  })
  it("retains safe Meta codes without logging response secrets", async () => {
    fail = "pin"
    const result = await finalizeWhatsAppRegistration(7, 4, "123456")
    expect(result.status).toBe("failed")
    expect(result.errorCode).toBe("133005")
    expect(result.errorMessage).toContain("Meta error 133005")
    const logs = JSON.stringify([vi.mocked(console.info).mock.calls, vi.mocked(console.warn).mock.calls])
    expect(logs).not.toContain("tenant-seven-token")
    expect(logs).not.toContain("123456")
    expect(logs).toContain("meta_error_subcode")
  })
  it("retries with the saved PIN and verifies before sending", async () => {
    fail = "pin"; await finalizeWhatsAppRegistration(7, 4, "123456")
    fail = undefined; await finalizeWhatsAppRegistration(7, 4)
    const payloads = mock.fetch.mock.calls.filter(([, r]) => r.method === "POST").map(([, r]) => JSON.parse(r.body))
    expect(payloads.map(p => p.pin)).toEqual(["123456", "123456"])
  })
  it("expired tokens fail without registration", async () => {
    fail = "auth"
    expect((await finalizeWhatsAppRegistration(7, 4)).errorCode).toBe("190")
    expect(posts).toBe(0)
  })
  it("missing phone IDs and unreadable tokens fail closed", async () => {
    row.phone_number_id = ""
    expect((await finalizeWhatsAppRegistration(7, 4)).errorCode).toBe("OWNERSHIP")
    row.access_token = ""
    expect((await finalizeWhatsAppRegistration(7, 4)).errorCode).toBe("CREDENTIALS")
    expect(mock.fetch).not.toHaveBeenCalled()
  })
  it("rejects another tenant's connection before touching Meta", async () => {
    await expect(finalizeWhatsAppRegistration(99, 4)).rejects.toThrow("not found")
    expect(mock.fetch).not.toHaveBeenCalled()
  })
  it("uses the second tenant's WABA, phone and token, never global identity", async () => {
    row = { id: 9, tenant_id: 8, waba_id: "300", phone_number_id: "400", access_token: encryptToken("tenant-eight-token") }
    await finalizeWhatsAppRegistration(8, 9)
    expect(mock.fetch.mock.calls.every(([url, r]) => /^\/v26.0\/(300|400)(\/|$)/.test(new URL(url).pathname) && r.headers.Authorization === "Bearer tenant-eight-token")).toBe(true)
  })
  it("quarantines API timeouts and probes Meta again on retry", async () => {
    fail = "timeout"
    expect((await finalizeWhatsAppRegistration(7, 4)).status).toBe("uncertain")
    fail = undefined; status = "CONNECTED"
    await finalizeWhatsAppRegistration(7, 4)
    expect(posts).toBe(1)
  })
  it("requires encryption rather than storing a plaintext generated PIN", async () => {
    row.access_token = "legacy-token"
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "")
    expect((await finalizeWhatsAppRegistration(7, 4)).errorCode).toBe("ENCRYPTION_REQUIRED")
    expect(posts).toBe(0)
    expect(savedPin).toBeNull()
  })
  it("refreshes registration from Meta rather than trusting saved booleans", async () => {
    expect((await readMetaRegistration(row)).cloudApiRegistered).toBe(false)
    status = "CONNECTED"
    expect((await readMetaRegistration(row)).cloudApiRegistered).toBe(true)
    status = undefined
    expect((await readMetaRegistration(row)).status).toBe("unconfirmed")
  })
  it("does not register a phone missing from the WABA", async () => {
    mock.fetch.mockResolvedValue(ok({ data: [] }))
    expect((await finalizeWhatsAppRegistration(7, 4)).errorCode).toBe("OWNERSHIP")
    expect(posts).toBe(0)
  })
  it("rejects a phone ambiguously shared by two tenants", async () => {
    mock.sql.mockImplementation(async sql => sql.includes("tenant_id<>?") ? [{ tenant_id: 8 }] : [])
    expect((await finalizeWhatsAppRegistration(7, 4)).errorCode).toBe("OWNERSHIP")
    expect(mock.fetch).not.toHaveBeenCalled()
  })
})
