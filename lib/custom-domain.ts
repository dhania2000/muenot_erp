/**
 * SPEC 157 — Custom Domain (pure logic).
 * ---------------------------------------------------------------------------
 * The security-critical heart of the custom-domain feature, kept free of any
 * I/O (no DB, no DNS, no `server-only`) so it can be unit-tested exhaustively —
 * especially the host-handling paths that face untrusted input (PHASE 4).
 *
 * Responsibilities:
 *   • Normalize an arbitrary, possibly hostile Host header / user input into a
 *     bare hostname (or reject it).
 *   • Validate that a hostname is an acceptable customer custom domain — never
 *     an IP, never localhost, never a platform-owned domain, never a wildcard.
 *   • Produce the DNS records the customer must publish (ownership TXT + routing
 *     CNAME) and describe the managed-TLS architecture.
 *   • Resolve an incoming host to an ACTIVE tenant domain (pure matcher; the
 *     store feeds it rows).
 *
 * The DB persistence + live DNS checks live in lib/custom-domain-store.ts.
 */

/** Lifecycle of a tenant custom domain. Only `active` domains resolve traffic. */
export type DomainStatus = "pending" | "verified" | "active" | "disabled" | "failed"

/** Feature flag (see lib/platform/entitlements.ts) that unlocks custom domains. */
export const CUSTOM_DOMAIN_FLAG = "custom_domain"

/**
 * Domains the platform itself owns. A customer can never claim these (or any
 * subdomain of them) as a "custom" domain — those hostnames are served by the
 * platform's own default routing, not the per-tenant custom-domain layer.
 */
export const PLATFORM_ROOT_DOMAINS = ["muenot.app", "muenot.com", "vercel.app"] as const

/** The CNAME target every custom domain must point at (the managed edge). */
export const DOMAIN_CNAME_TARGET = "cname.muenot.app"

/** The sub-label under the customer domain that holds the ownership TXT record. */
export const VERIFICATION_TXT_HOST = "_muenot-challenge"

/** Prefix stamped into the TXT value so the challenge is self-describing. */
export const VERIFICATION_VALUE_PREFIX = "muenot-domain-verify="

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isIpv4(host: string): boolean {
  const m = IPV4_RE.exec(host)
  if (!m) return false
  return m.slice(1).every((oct) => {
    const n = Number(oct)
    return n >= 0 && n <= 255 && String(n) === oct
  })
}

/** True when `hostname` is a platform-owned domain or a subdomain of one. */
export function isPlatformDomain(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return PLATFORM_ROOT_DOMAINS.some((root) => h === root || h.endsWith(`.${root}`))
}

/**
 * Reduce arbitrary input (a raw Host header, a pasted URL, user typing) to a
 * bare lowercase hostname, or null when nothing usable remains. Deliberately
 * defensive: strips scheme, credentials, path/query/fragment, port and any
 * trailing dot so downstream comparisons are canonical and a crafted Host can
 * never smuggle a path or port past validation.
 */
export function normalizeHostname(input: unknown): string | null {
  if (typeof input !== "string") return null
  let h = input.trim().toLowerCase()
  if (!h) return null
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // scheme://
  h = h.replace(/^[^@/]*@/, "") // user:pass@
  h = h.split(/[/?#]/)[0] // path / query / fragment
  if (h.startsWith("[")) {
    // Bracketed IPv6 literal, optionally with a trailing :port — take the inner
    // address (validation rejects IPs, but normalization must be canonical).
    const end = h.indexOf("]")
    if (end !== -1) h = h.slice(1, end)
  } else {
    h = h.replace(/:\d+$/, "") // :port
  }
  h = h.replace(/\.+$/, "") // trailing dot(s)
  if (!h) return null
  return h
}

export type DomainValidation = { ok: true; hostname: string } | { ok: false; reason: string }

/**
 * Validate that `input` is an acceptable customer custom domain. Returns the
 * canonical hostname on success, or a user-facing reason on rejection. This is
 * the single gate every write path (and every test of hostile input) goes
 * through.
 */
export function validateCustomDomain(input: unknown): DomainValidation {
  const hostname = normalizeHostname(input)
  if (!hostname) return { ok: false, reason: "Enter a domain name." }
  if (hostname.length > 253) return { ok: false, reason: "Domain is too long." }
  if (hostname.includes("*")) return { ok: false, reason: "Wildcard domains are not supported." }
  if (hostname.includes(":") || isIpv4(hostname)) {
    return { ok: false, reason: "IP addresses are not allowed — use a domain name." }
  }
  if (hostname === "localhost") return { ok: false, reason: "localhost cannot be used." }

  const labels = hostname.split(".")
  if (labels.length < 2) {
    return { ok: false, reason: "Enter a fully-qualified domain, e.g. erp.yourcompany.com." }
  }
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      return { ok: false, reason: "Each part of the domain must be 1–63 characters." }
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return { ok: false, reason: "Domains may only contain letters, numbers and hyphens." }
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, reason: "Domain parts cannot start or end with a hyphen." }
    }
  }
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) {
    return { ok: false, reason: "The domain must end in a valid top-level domain." }
  }
  if (isPlatformDomain(hostname)) {
    return { ok: false, reason: "That domain is reserved by the platform." }
  }
  return { ok: true, hostname }
}

/** Cryptographically-random opaque verification token (48 hex chars). */
export function newVerificationToken(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** The exact TXT value a customer must publish for the given token. */
export function verificationTxtValue(token: string): string {
  return `${VERIFICATION_VALUE_PREFIX}${token}`
}

export type DnsRecord = {
  type: "TXT" | "CNAME"
  /** Fully-qualified record host (what the DNS zone will show). */
  host: string
  /** The record value to publish. */
  value: string
  /** Why this record exists, for the UI. */
  purpose: string
}

/**
 * The DNS records the customer must publish: a TXT proving ownership and a
 * CNAME routing the hostname to the managed edge. Pure — safe to render.
 */
export function dnsInstructions(hostname: string, token: string): DnsRecord[] {
  return [
    {
      type: "TXT",
      host: `${VERIFICATION_TXT_HOST}.${hostname}`,
      value: verificationTxtValue(token),
      purpose: "Proves you control this domain (ownership verification).",
    },
    {
      type: "CNAME",
      host: hostname,
      value: DOMAIN_CNAME_TARGET,
      purpose: "Routes requests for this domain to your workspace over HTTPS.",
    },
  ]
}

/**
 * Human-readable description of how TLS is provisioned, surfaced in the config
 * UI so admins understand no certificate handling is required on their side.
 */
export const TLS_ARCHITECTURE = {
  summary:
    "TLS certificates are issued and renewed automatically by the managed edge. You never upload or rotate a certificate.",
  points: [
    "Once the CNAME points at the managed edge, an ACME (Let's Encrypt) certificate is provisioned for the hostname.",
    "Certificates auto-renew before expiry; HTTP is redirected to HTTPS and HSTS is enforced.",
    "Traffic terminates TLS at the edge and is routed to the tenant resolved from the hostname.",
  ],
} as const

/**
 * Pure resolver: given an incoming host and the set of a tenant's (or all
 * tenants') domain rows, return the matching ACTIVE domain, or null. Never
 * matches pending/verified/disabled/failed domains, so a domain that has not
 * been activated can never serve traffic.
 */
export function resolveActiveDomain<T extends { hostname: string; status: DomainStatus }>(
  host: unknown,
  domains: readonly T[],
): T | null {
  const h = normalizeHostname(host)
  if (!h) return null
  for (const d of domains) {
    if (d.status === "active" && normalizeHostname(d.hostname) === h) return d
  }
  return null
}

/** Whether a domain in `from` status may transition to `to` (UI + store guard). */
export function canTransitionTo(from: DomainStatus, to: DomainStatus): boolean {
  switch (to) {
    case "verified":
    case "failed":
      // Result of a verification attempt — allowed from any non-terminal state.
      return from !== "active"
    case "active":
      // Can only go live once ownership has been proven.
      return from === "verified" || from === "disabled"
    case "disabled":
      return from === "active" || from === "verified"
    default:
      return false
  }
}
