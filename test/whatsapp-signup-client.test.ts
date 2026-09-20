import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { launchFacebookSignup, requireSignupConfig, signupDetails, type FacebookSdk } from "@/lib/whatsapp-signup-client"
import { EmbeddedSignupConnect } from "@/components/marketing/whatsapp/embedded-signup-connect"

const config = { ready: true, appId: "123", configId: "456", graphVersion: "v26.0" }
afterEach(() => vi.useRealTimers())

describe("Meta popup launch", () => {
  it("calls SDK login synchronously in the click task with Business Login options", async () => {
    const sdk: FacebookSdk = { init: vi.fn(), login: vi.fn(callback => callback({ authResponse: { code: "test-code" } })) }
    const result = launchFacebookSignup(sdk, config)
    expect(sdk.login).toHaveBeenCalledTimes(1) // before awaiting any promise
    expect(sdk.init).toHaveBeenCalledWith(expect.objectContaining({ appId: "123", version: "v26.0" }))
    expect(sdk.login).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      config_id: "456", response_type: "code", override_default_response_type: true,
      extras: expect.objectContaining({ sessionInfoVersion: "3" }),
    }))
    expect(await result).toEqual({ authResponse: { code: "test-code" } })
  })
  it("explains missing configuration rather than attempting an invalid Facebook login", () => {
    expect(() => requireSignupConfig({ ...config, ready: false, configId: null, missing: ["WHATSAPP_CONFIG_ID"] })).toThrow("WHATSAPP_CONFIG_ID")
  })
  it("handles cancellation without inventing an authorization code", async () => {
    const sdk = { init: vi.fn(), login: vi.fn(callback => callback({ status: "unknown" })) }
    expect((await launchFacebookSignup(sdk, config)).authResponse).toBeUndefined()
  })
  it("recovers from SDK exceptions", async () => {
    const sdk = { init: vi.fn(), login: vi.fn(() => { throw new Error("SDK unavailable") }) }
    await expect(launchFacebookSignup(sdk, config)).rejects.toThrow("SDK unavailable")
  })
  it("times out a blocked or abandoned popup so retry remains possible", async () => {
    vi.useFakeTimers()
    const result = launchFacebookSignup({ init: vi.fn(), login: vi.fn() }, config)
    const assertion = expect(result).rejects.toThrow("Allow popups")
    await vi.advanceTimersByTimeAsync(180000)
    await assertion
  })
  it("renders a clickable initial button with visible preparation status", () => {
    const markup = renderToStaticMarkup(createElement(EmbeddedSignupConnect, { onConnected: () => {} }))
    expect(markup).toContain("Connect with Meta")
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('role="status"')
  })
})

describe("Meta signup messages", () => {
  const data = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "123", phone_number_id: "456", business_id: "789" } }
  it.each(["https://www.facebook.com", "https://web.facebook.com"])("accepts exact trusted origin %s", origin => {
    expect(signupDetails({ origin, data: JSON.stringify(data) })).toEqual({ wabaId: "123", phoneNumberId: "456", businessId: "789" })
  })
  it.each(["https://facebook.com.attacker.test", "https://attackerfacebook.com", "http://www.facebook.com"])("rejects untrusted origin %s", origin => {
    expect(signupDetails({ origin, data })).toBeNull()
  })
  it("rejects malformed, cancellation and incomplete messages", () => {
    const origin = "https://www.facebook.com"
    for (const invalid of ["not-json", { ...data, event: "CANCEL" }, { ...data, data: { waba_id: "123" } }]) {
      expect(signupDetails({ origin, data: invalid })).toBeNull()
    }
  })
})
