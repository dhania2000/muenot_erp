/**
 * Centralized redirect/origin configuration for WhatsApp Embedded Signup.
 *
 * The onboarding flow uses the Meta JS SDK (`FB.login` with
 * `response_type: "code"`). The SDK controls the OAuth `redirect_uri`
 * internally — it is NOT supplied by us. What Meta actually validates for a
 * JS-SDK login is the top-level page origin, which must be listed under:
 *   - App Settings → Basic → App Domains
 *   - Facebook Login for Business → Settings → Allowed Domains for the JS SDK
 *   - Facebook Login for Business → Settings → Valid OAuth Redirect URIs
 *
 * This module is the single source of truth for that origin so the value we
 * report in diagnostics always matches what the SDK sends.
 */

/** Production ERP origin — the canonical value that must be whitelisted in Meta. */
export const WHATSAPP_PRODUCTION_ORIGIN = "https://erp.muenot.co.in"

/**
 * Resolves the origin that the Meta JS SDK will present to Meta during
 * Embedded Signup.
 *
 * Priority:
 *   1. `NEXT_PUBLIC_APP_URL` (explicit override, trailing slash trimmed)
 *   2. `window.location.origin` (the real origin the SDK actually uses)
 *   3. The production ERP origin (SSR / non-browser fallback)
 */
export function resolveEmbeddedSignupOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "")
  if (configured) return configured
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin
  }
  return WHATSAPP_PRODUCTION_ORIGIN
}
