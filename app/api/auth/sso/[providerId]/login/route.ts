import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { getProviderById, resolveClientSecret } from "@/lib/sso-store"
import { buildAuthorizationUrl, generatePkcePair, resolveEndpoints } from "@/lib/sso-oidc"
import { issueSsoState } from "@/lib/sso-state"

function requestOrigin(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto") || "https"
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || ""
  return `${proto}://${host}`
}

/** SPEC 56-57 — redirects the browser to the IdP's authorization endpoint. */
export async function GET(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params
  const provider = await getProviderById(Number(providerId))
  if (provider?.type === "saml") return NextResponse.redirect(new URL(`/api/auth/sso/${provider.id}/saml/login`, requestOrigin(request)))
  if (!provider || provider.type !== "oidc" || provider.status !== "enabled") {
    return NextResponse.redirect(new URL("/login?sso_error=unavailable", requestOrigin(request)))
  }
  if (!provider.client_id || !resolveClientSecret(provider)) {
    return NextResponse.redirect(new URL("/login?sso_error=misconfigured", requestOrigin(request)))
  }

  try {
    const endpoints = await resolveEndpoints(provider)
    const state = randomUUID()
    const nonce = randomUUID()
    const pkce = generatePkcePair()
    const redirectUri = `${requestOrigin(request)}/api/auth/sso/${provider.id}/callback`

    await issueSsoState({ providerId: provider.id, state, nonce, codeVerifier: pkce.verifier, redirectTo: "/dashboard" })

    const authUrl = buildAuthorizationUrl({
      endpoint: endpoints.authorization_endpoint,
      clientId: provider.client_id,
      redirectUri,
      scopes: provider.scopes || "openid email profile",
      state,
      nonce,
      codeChallenge: pkce.challenge,
    })
    return NextResponse.redirect(authUrl)
  } catch (err) {
    console.error("[v0] sso login initiate failed", err)
    return NextResponse.redirect(new URL("/login?sso_error=unavailable", requestOrigin(request)))
  }
}
