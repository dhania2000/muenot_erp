/**
 * Geo (country) protection — pure, testable decision core (Spec25 · #213).
 * ---------------------------------------------------------------------------
 * A tenant may declare a country policy in one of two modes:
 *
 *   mode = "allow" → an allow-list. Access is permitted ONLY from the listed
 *                    countries; every other resolved country is denied.
 *   mode = "block" → a block-list. Access is denied from the listed countries;
 *                    every other resolved country is permitted.
 *
 * The country MUST come from a TRUSTED geolocation source (the edge resolves it
 * from the real connecting IP — see lib/geo.ts). A VPN, proxy, or otherwise
 * unresolvable location yields an UNKNOWN country. Unknown handling is an
 * explicit, fail-safe tenant choice:
 *
 *   unknownAction = "block" (default, fail-closed) → deny when location unknown.
 *   unknownAction = "allow"                        → permit when location unknown.
 *
 * Emergency access is a separate, audited escape hatch layered on top of this
 * decision by the store — this core only reports the raw policy decision so it
 * stays deterministic and unit-testable with no I/O.
 *
 * No `server-only`, Node, or DB import: safe to unit-test and (type-only) share
 * with the UI.
 */

export type GeoPolicyMode = "allow" | "block"
export type GeoUnknownAction = "block" | "allow"

export type GeoPolicy = {
  enabled: boolean
  mode: GeoPolicyMode
  /** ISO 3166-1 alpha-2 country codes, upper-cased. */
  countries: string[]
  unknownAction: GeoUnknownAction
}

export type GeoDecisionReason =
  | "policy_disabled"
  | "no_countries_configured"
  | "country_allowed"
  | "country_blocked"
  | "country_not_in_allowlist"
  | "location_unknown_allowed"
  | "location_unknown_blocked"

export type GeoDecision = {
  denied: boolean
  /** True when the deny/allow was decided by the unknown-location fail-safe. */
  unknownLocation: boolean
  reason: GeoDecisionReason
  /** The normalized country the decision was made against (null when unknown). */
  country: string | null
}

/** Normalize a raw country value to an upper-case alpha-2 code, or null. */
export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(trimmed)) return null
  // Vercel/edge use "XX" / "T1" (Tor) for unresolved locations — treat as unknown.
  if (trimmed === "XX" || trimmed === "T1") return null
  return trimmed
}

/** Normalize and de-duplicate a list of country codes, dropping invalid ones. */
export function normalizeCountryList(values: unknown): string[] {
  const input = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(/[,\s]+/)
      : []
  const seen = new Set<string>()
  for (const v of input) {
    const code = normalizeCountry(v)
    if (code) seen.add(code)
  }
  return [...seen].sort()
}

/**
 * Evaluate a resolved country against a tenant geo policy. `country` should be
 * the trusted, normalized country code, or null when the location is unknown
 * (VPN / proxy / unresolved IP). Pure and deterministic.
 */
export function evaluateGeoPolicy(policy: GeoPolicy, country: string | null): GeoDecision {
  if (!policy.enabled) {
    return { denied: false, unknownLocation: country == null, reason: "policy_disabled", country }
  }

  const list = normalizeCountryList(policy.countries)
  // A policy with no countries configured cannot meaningfully allow-list or
  // block-list; treat it as inert rather than locking everyone out.
  if (list.length === 0) {
    return { denied: false, unknownLocation: country == null, reason: "no_countries_configured", country }
  }

  const resolved = normalizeCountry(country)
  if (resolved == null) {
    const denied = policy.unknownAction !== "allow" // default fail-closed
    return {
      denied,
      unknownLocation: true,
      reason: denied ? "location_unknown_blocked" : "location_unknown_allowed",
      country: null,
    }
  }

  const inList = list.includes(resolved)
  if (policy.mode === "allow") {
    return inList
      ? { denied: false, unknownLocation: false, reason: "country_allowed", country: resolved }
      : { denied: true, unknownLocation: false, reason: "country_not_in_allowlist", country: resolved }
  }
  // block-list
  return inList
    ? { denied: true, unknownLocation: false, reason: "country_blocked", country: resolved }
    : { denied: false, unknownLocation: false, reason: "country_allowed", country: resolved }
}
