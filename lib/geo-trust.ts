/**
 * Trusted IP geolocation resolution (Spec25 · #213).
 * ---------------------------------------------------------------------------
 * A country header is only as trustworthy as the proxy that set it. On a
 * self-hosted deployment (server.js / desktop) any client can send
 * `x-vercel-ip-country: US`, so this module only honours a geo header from a
 * source the operator has declared trusted:
 *
 *   - `vercel`     → `x-vercel-ip-country` (set by Vercel's edge; clients cannot
 *                    override it). Default when running on Vercel (VERCEL=1).
 *   - `cloudflare` → `cf-ipcountry` (only safe when the origin is locked to
 *                    Cloudflare). Must be opted into via GEO_TRUSTED_SOURCE.
 *   - `none`       → no trusted geo source; every location is UNKNOWN.
 *
 * Anything that cannot be resolved to a real country — missing header, private
 * or reserved IP, the edge's "unknown" (XX) / Tor (T1) / anonymous-proxy codes,
 * or a trusted anonymizer/VPN flag header — is reported as UNKNOWN so the geo
 * policy's fail-safe (`unknown_action`) decides. Pure over (headers, ip, env).
 */
import { normalizeCountry } from "@/lib/geo-policy-core"

export type GeoTrustSource = "vercel" | "cloudflare" | "none"

export type TrustedGeoReason =
  | "resolved"
  | "untrusted_source"
  | "missing_header"
  | "private_ip"
  | "anonymizer"
  | "unresolvable_code"

export type TrustedGeo = {
  /** Trusted ISO alpha-2 country, or null when the location is unknown. */
  country: string | null
  source: GeoTrustSource
  /** True when the request is known to come via VPN / proxy / Tor. */
  anonymous: boolean
  reason: TrustedGeoReason
}

type Env = Record<string, string | undefined>

const SOURCE_HEADER: Record<Exclude<GeoTrustSource, "none">, string> = {
  vercel: "x-vercel-ip-country",
  cloudflare: "cf-ipcountry",
}

/** Edge codes meaning "not a real country". T1 = Tor, A1/A2 = anonymous/satellite proxy. */
const ANONYMOUS_CODES = new Set(["T1", "A1", "A2"])
const UNRESOLVABLE_CODES = new Set(["XX", "ZZ", "O1", "EU", "AP", ...ANONYMOUS_CODES])

export function resolveGeoTrustSource(env: Env = process.env): GeoTrustSource {
  const configured = (env.GEO_TRUSTED_SOURCE ?? "").trim().toLowerCase()
  if (configured === "vercel" || configured === "cloudflare" || configured === "none") return configured
  return env.VERCEL === "1" ? "vercel" : "none"
}

/** Loopback, RFC1918, CGNAT, link-local and IPv6 ULA/link-local — never geolocatable. */
export function isPrivateOrReservedIp(ip: string | null | undefined): boolean {
  if (!ip) return false
  let v = ip.trim().toLowerCase()
  if (v.startsWith("::ffff:")) v = v.slice(7)
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")
}

function truthyFlag(value: string | null): boolean {
  if (!value) return false
  return ["1", "true", "yes", "vpn", "proxy", "tor", "hosting"].includes(value.trim().toLowerCase())
}

export function resolveTrustedGeo(headers: Headers, ip: string | null, env: Env = process.env): TrustedGeo {
  const source = resolveGeoTrustSource(env)
  if (source === "none") return { country: null, source, anonymous: false, reason: "untrusted_source" }

  // Optional anonymizer flag set by the trusted proxy / geo-IP provider
  // (e.g. GEO_ANONYMIZER_HEADER=x-geo-anonymous). Treated as unknown location.
  const anonymizerHeader = env.GEO_ANONYMIZER_HEADER?.trim()
  if (anonymizerHeader && truthyFlag(headers.get(anonymizerHeader))) {
    return { country: null, source, anonymous: true, reason: "anonymizer" }
  }

  if (isPrivateOrReservedIp(ip)) return { country: null, source, anonymous: false, reason: "private_ip" }

  const raw = headers.get(SOURCE_HEADER[source])?.trim().toUpperCase() ?? ""
  if (!raw) return { country: null, source, anonymous: false, reason: "missing_header" }
  if (UNRESOLVABLE_CODES.has(raw)) {
    return { country: null, source, anonymous: ANONYMOUS_CODES.has(raw), reason: "unresolvable_code" }
  }
  const country = normalizeCountry(raw)
  if (!country) return { country: null, source, anonymous: false, reason: "unresolvable_code" }
  return { country, source, anonymous: false, reason: "resolved" }
}
