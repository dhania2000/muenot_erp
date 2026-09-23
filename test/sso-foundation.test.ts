import { describe, expect, it } from "vitest"
import { SSO_OIDC_PRESETS, sameTenant } from "@/lib/sso-provider-catalog"

describe(" SSO foundation", () => {
  it("supplies safe OIDC presets for supported enterprise providers", () => {
    expect(SSO_OIDC_PRESETS.google_workspace.discoveryUrl).toContain("accounts.google.com")
    expect(SSO_OIDC_PRESETS.microsoft_entra.discoveryUrl).toContain("login.microsoftonline.com")
    expect(SSO_OIDC_PRESETS.okta.label).toBe("Okta")
  })
  it("never links a tenant provider to a user from another tenant", () => {
    expect(sameTenant(5, 5)).toBe(true)
    expect(sameTenant(5, 9)).toBe(false)
  })
})
