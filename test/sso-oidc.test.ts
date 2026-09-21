import { describe, expect, it } from "vitest"
import { buildAuthorizationUrl, generatePkcePair } from "@/lib/sso-oidc"

describe("SPEC 57 OIDC authorization security", () => {
  it("uses a high-entropy verifier and S256 challenge", () => {
    const { verifier, challenge } = generatePkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
  it("includes state, nonce and PKCE in the authorization request", () => {
    const { challenge } = generatePkcePair()
    const url = new URL(buildAuthorizationUrl({ endpoint: "https://idp.example/authorize", clientId: "client", redirectUri: "https://erp.example/callback", scopes: "openid email", state: "state", nonce: "nonce", codeChallenge: challenge }))
    expect(url.searchParams.get("state")).toBe("state")
    expect(url.searchParams.get("nonce")).toBe("nonce")
    expect(url.searchParams.get("code_challenge")).toBe(challenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })
})
