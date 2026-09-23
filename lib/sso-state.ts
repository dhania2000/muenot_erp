import "server-only"
/**
 * — short-lived, signed cookie carrying the OAuth `state` and
 * OIDC `nonce` between the /login redirect and the /callback handler.
 * Signed (not just opaque) so a tampered value fails verification outright;
 * short TTL (5 min) limits the CSRF/replay window.
 */
import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"

export const SSO_STATE_COOKIE = "ems_sso_state"
const TTL_SECONDS = 5 * 60

function getSecretKey() {
  const secret = process.env.SESSION_SECRET
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) throw new Error("SESSION_SECRET must be configured for SSO")
  return new TextEncoder().encode(secret || "dev-only-insecure-secret-change-me")
}

export type SsoStatePayload = {
  providerId: number
  protocol?: "oidc" | "saml"
  state: string
  nonce: string
  codeVerifier?: string
  redirectTo: string
}

export async function issueSsoState(payload: SsoStatePayload): Promise<void> {
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(getSecretKey())
  const cookieStore = await cookies()
  cookieStore.set(SSO_STATE_COOKIE, token, {
    httpOnly: true,
    // SAML ACS is a cross-site POST from the IdP: Lax cookies are not sent.
    // None requires Secure; OIDC's top-level GET callback keeps Lax.
    secure: payload.protocol === "saml" || process.env.NODE_ENV === "production",
    sameSite: payload.protocol === "saml" ? "none" : "lax",
    path: "/",
    maxAge: TTL_SECONDS,
  })
}

export async function consumeSsoState(): Promise<SsoStatePayload | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SSO_STATE_COOKIE)?.value
  cookieStore.delete(SSO_STATE_COOKIE)
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    const state = payload as unknown as SsoStatePayload
    if (!Number.isSafeInteger(state.providerId) || !state.state || !state.nonce) return null
    if ((state.protocol ?? "oidc") === "oidc" && !/^[A-Za-z0-9_-]{43,128}$/.test(state.codeVerifier || "")) return null
    return state
  } catch {
    return null
  }
}
