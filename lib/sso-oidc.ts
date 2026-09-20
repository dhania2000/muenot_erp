import "server-only"
/**
 * SPEC 56-57 — OIDC protocol handshake.
 * ---------------------------------------------------------------------------
 * Implements the authorization-code flow against a generic OIDC provider
 * (Google Workspace, Microsoft Entra ID, Okta, or "Generic OIDC" all speak
 * this same protocol). Discovery documents are cached in-memory per issuer
 * for the process lifetime — cheap enough to skip a DB table, and refetched
 * automatically after a restart. Signature verification always happens
 * against the provider's live JWKS (jose's createRemoteJWKSet), never a
 * pinned key, so key rotation on the IdP side never breaks login.
 */
import { createRemoteJWKSet, jwtVerify } from "jose"
import type { SsoProviderRow } from "@/lib/sso-store"

type Discovery = {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri: string
  issuer: string
}

const discoveryCache = new Map<string, { doc: Discovery; fetchedAt: number }>()
const JWKS_TTL_MS = 60 * 60 * 1000

export async function resolveDiscovery(discoveryUrl: string): Promise<Discovery> {
  const cached = discoveryCache.get(discoveryUrl)
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.doc
  const res = await fetch(discoveryUrl, { cache: "no-store" })
  if (!res.ok) throw new Error(`Discovery document fetch failed (${res.status})`)
  const doc = (await res.json()) as Discovery
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("Discovery document is missing required endpoints")
  }
  discoveryCache.set(discoveryUrl, { doc, fetchedAt: Date.now() })
  return doc
}

/** Resolve the provider's effective endpoints — from manual config when set, else from discovery. */
export async function resolveEndpoints(provider: SsoProviderRow): Promise<Discovery> {
  if (provider.discovery_url) return resolveDiscovery(provider.discovery_url)
  if (provider.authorization_endpoint && provider.token_endpoint && provider.jwks_uri) {
    return {
      authorization_endpoint: provider.authorization_endpoint,
      token_endpoint: provider.token_endpoint,
      userinfo_endpoint: provider.userinfo_endpoint ?? undefined,
      jwks_uri: provider.jwks_uri,
      issuer: provider.issuer_url ?? "",
    }
  }
  throw new Error("Provider has neither a discovery URL nor manually configured endpoints")
}

export function buildAuthorizationUrl(opts: {
  endpoint: string
  clientId: string
  redirectUri: string
  scopes: string
  state: string
  nonce: string
}): string {
  const url = new URL(opts.endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", opts.clientId)
  url.searchParams.set("redirect_uri", opts.redirectUri)
  url.searchParams.set("scope", opts.scopes || "openid email profile")
  url.searchParams.set("state", opts.state)
  url.searchParams.set("nonce", opts.nonce)
  return url.toString()
}

export type OidcClaims = {
  sub: string
  email?: string
  email_verified?: boolean
  given_name?: string
  family_name?: string
  name?: string
}

/** Exchange the authorization code for tokens and verify the ID token against the IdP's live JWKS. */
export async function exchangeCodeForClaims(opts: {
  tokenEndpoint: string
  jwksUri: string
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  nonce: string
}): Promise<OidcClaims> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  })
  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.id_token) {
    throw new Error(data?.error_description || data?.error || "Token exchange failed")
  }

  const jwks = createRemoteJWKSet(new URL(opts.jwksUri))
  const { payload } = await jwtVerify(data.id_token, jwks, {
    audience: opts.clientId,
    ...(opts.issuer ? { issuer: opts.issuer } : {}),
  })

  if (payload.nonce && payload.nonce !== opts.nonce) {
    throw new Error("Nonce mismatch — possible replay")
  }
  if (!payload.sub) throw new Error("ID token missing subject")

  return {
    sub: String(payload.sub),
    email: typeof payload.email === "string" ? payload.email : undefined,
    email_verified: Boolean(payload.email_verified),
    given_name: typeof payload.given_name === "string" ? payload.given_name : undefined,
    family_name: typeof payload.family_name === "string" ? payload.family_name : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  }
}
