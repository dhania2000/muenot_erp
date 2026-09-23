import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/whatsapp", () => ({ GRAPH_VERSION: "v26.0", getAppId: () => "app-id", getAppSecret: () => "server-secret" }))
import { discoverSignupAssets } from "@/lib/whatsapp-signup-discovery"

const json = (body: object, ok = true) => ({ ok, json: async () => body }) as Response
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("debug_token")
    ? json({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["123"] }] } })
    : json({ data: [{ id: "456" }] })))
})

describe("Meta asset discovery after Embedded Signup", () => {
  it("discovers exact WABA and phone when browser session info is absent", async () => {
    expect(await discoverSignupAssets("private-token", {})).toEqual({ wabaId: "123", phoneNumberId: "456", businessId: undefined })
    const calls = vi.mocked(fetch).mock.calls
    expect(calls[0][1]?.headers).toEqual({ Authorization: "Bearer app-id|server-secret" })
    expect(calls[1][1]?.headers).toEqual({ Authorization: "Bearer private-token" })
  })
  it("rejects browser-supplied WABA or phone not authorized by Meta", async () => {
    await expect(discoverSignupAssets("private-token", { wabaId: "999" })).rejects.toMatchObject({ code: "WABA_MISMATCH" })
    await expect(discoverSignupAssets("private-token", { wabaId: "123", phoneNumberId: "999" })).rejects.toMatchObject({ code: "PHONE_MISMATCH" })
  })
  it("distinguishes ambiguous WABA and phone discovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("debug_token")
      ? json({ data: { granular_scopes: [] } }) : json({ data: [{ id: "456" }, { id: "789" }] })))
    await expect(discoverSignupAssets("private-token", {})).rejects.toMatchObject({ code: "WABA_ID_MISSING" })
    await expect(discoverSignupAssets("private-token", { wabaId: "123" })).rejects.toMatchObject({ code: "PHONE_NUMBER_ID_MISSING" })
  })
  it("returns a safe failure code when Meta discovery fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, false)))
    await expect(discoverSignupAssets("private-token", {})).rejects.toMatchObject({ code: "META_DISCOVERY_FAILED" })
  })
})
