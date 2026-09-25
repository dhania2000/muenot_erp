import "server-only"
/**
 * Relying-Party (origin + rpId) derivation for WebAuthn ceremonies.
 * ---------------------------------------------------------------------------
 * A challenge is bound to the exact origin it was issued for, and verification
 * requires the browser-reported origin to match. We derive that origin from the
 * request the ceremony started on (its `Origin` header, falling back to the
 * forwarded host) so the app works unchanged across localhost and every Vercel
 * preview/production domain without hard-coded configuration. An operator can
 * still pin the values explicitly with WEBAUTHN_ORIGIN / WEBAUTHN_RP_ID.
 *
 * rpId is the registrable domain (the host without scheme/port). The browser
 * only permits an rpId that is equal to, or a parent of, the current origin's
 * host, so deriving it from the same request keeps the two consistent.
 */
export type RelyingParty = { origin: string; rpId: string }

export function deriveRelyingParty(request: Request): RelyingParty | null {
  const envOrigin = process.env.WEBAUTHN_ORIGIN?.trim()
  const envRpId = process.env.WEBAUTHN_RP_ID?.trim()
  if (envOrigin) {
    try {
      const url = new URL(envOrigin)
      return { origin: url.origin, rpId: envRpId || url.hostname }
    } catch {
      // fall through to request-derived values
    }
  }

  const headerOrigin = request.headers.get("origin")
  if (headerOrigin) {
    try {
      const url = new URL(headerOrigin)
      return { origin: url.origin, rpId: envRpId || url.hostname }
    } catch {
      // fall through
    }
  }

  // Fallback: reconstruct from forwarded proto + host (e.g. server-to-server).
  const proto = request.headers.get("x-forwarded-proto") ?? "https"
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  if (host) {
    try {
      const url = new URL(`${proto}://${host}`)
      return { origin: url.origin, rpId: envRpId || url.hostname }
    } catch {
      // fall through
    }
  }
  return null
}
