import { describe, expect, it } from "vitest"
import {
  normalizeHostname,
  validateCustomDomain,
  isPlatformDomain,
  resolveActiveDomain,
  dnsInstructions,
  verificationTxtValue,
  canTransitionTo,
  newVerificationToken,
  DOMAIN_CNAME_TARGET,
  VERIFICATION_TXT_HOST,
  VERIFICATION_VALUE_PREFIX,
  type DomainStatus,
} from "@/lib/custom-domain"

/**
 * SPEC 157 — PHASE 4: incorrect / malicious host handling.
 * The custom-domain feature turns an untrusted Host header into a tenant, so
 * these tests hammer the pure gate that stands between hostile input and the
 * data layer.
 */
describe("normalizeHostname — hostile input reduction", () => {
  it("lowercases and trims", () => {
    expect(normalizeHostname("  ERP.Example.COM  ")).toBe("erp.example.com")
  })
  it("strips scheme, credentials, port, path, query and fragment", () => {
    expect(normalizeHostname("https://user:pass@erp.example.com:8443/login?x=1#z")).toBe("erp.example.com")
  })
  it("strips a trailing dot (FQDN root)", () => {
    expect(normalizeHostname("erp.example.com.")).toBe("erp.example.com")
  })
  it("unwraps a bracketed IPv6 literal", () => {
    expect(normalizeHostname("[::1]:3000")).toBe("::1")
  })
  it("does not let a path smuggle a fake host past normalization", () => {
    // The authoritative host is evil.com; the path is discarded.
    expect(normalizeHostname("evil.com/erp.example.com")).toBe("evil.com")
  })
  it("collapses a credential trick to the real host", () => {
    expect(normalizeHostname("erp.example.com@evil.com")).toBe("evil.com")
  })
  it("returns null for empty / non-string input", () => {
    expect(normalizeHostname("")).toBeNull()
    expect(normalizeHostname("   ")).toBeNull()
    expect(normalizeHostname(null)).toBeNull()
    expect(normalizeHostname(undefined)).toBeNull()
    expect(normalizeHostname(12345 as unknown)).toBeNull()
  })
})

describe("validateCustomDomain — rejects incorrect / malicious domains", () => {
  const rejected: [string, unknown][] = [
    ["empty", ""],
    ["single label", "com"],
    ["localhost", "localhost"],
    ["IPv4", "192.168.1.1"],
    ["link-local metadata IP", "169.254.169.254"],
    ["public IPv4", "8.8.8.8"],
    ["IPv6", "::1"],
    ["bracketed IPv6", "[2001:db8::1]"],
    ["wildcard", "*.example.com"],
    ["leading hyphen label", "-bad.example.com"],
    ["trailing hyphen label", "bad-.example.com"],
    ["space in host", "exa mple.com"],
    ["non-ascii", "exàmple.com"],
    ["underscore", "erp_x.example.com"],
    ["numeric TLD", "example.123"],
    ["too long", `${"a".repeat(250)}.com`],
    ["label over 63 chars", `${"a".repeat(64)}.example.com`],
    ["non-string", 42],
  ]
  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      const result = validateCustomDomain(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBeTruthy()
    })
  }

  it("rejects platform-owned domains and their subdomains", () => {
    expect(validateCustomDomain("muenot.com").ok).toBe(false)
    expect(validateCustomDomain("acme.muenot.app").ok).toBe(false)
    expect(validateCustomDomain("foo.vercel.app").ok).toBe(false)
  })

  it("accepts valid customer domains and returns the canonical hostname", () => {
    expect(validateCustomDomain("ERP.YourCompany.com")).toEqual({ ok: true, hostname: "erp.yourcompany.com" })
    expect(validateCustomDomain("a.b.co").ok).toBe(true)
    expect(validateCustomDomain("https://portal.acme.io/")).toEqual({ ok: true, hostname: "portal.acme.io" })
  })
})

describe("isPlatformDomain", () => {
  it("flags roots and subdomains but not lookalikes", () => {
    expect(isPlatformDomain("muenot.app")).toBe(true)
    expect(isPlatformDomain("tenant.muenot.app")).toBe(true)
    expect(isPlatformDomain("notmuenot.app")).toBe(false)
    expect(isPlatformDomain("muenot.app.evil.com")).toBe(false)
  })
})

describe("resolveActiveDomain — host → tenant matching", () => {
  const domains: { hostname: string; status: DomainStatus; tenantId: number }[] = [
    { hostname: "erp.acme.com", status: "active", tenantId: 1 },
    { hostname: "erp.beta.com", status: "verified", tenantId: 2 },
    { hostname: "erp.gamma.com", status: "pending", tenantId: 3 },
    { hostname: "erp.delta.com", status: "disabled", tenantId: 4 },
    { hostname: "erp.epsilon.com", status: "failed", tenantId: 5 },
  ]

  it("matches only an ACTIVE domain, case-insensitively", () => {
    expect(resolveActiveDomain("ERP.Acme.com", domains)?.tenantId).toBe(1)
    expect(resolveActiveDomain("https://erp.acme.com/login", domains)?.tenantId).toBe(1)
  })

  it("never matches a non-active domain (verified/pending/disabled/failed)", () => {
    expect(resolveActiveDomain("erp.beta.com", domains)).toBeNull()
    expect(resolveActiveDomain("erp.gamma.com", domains)).toBeNull()
    expect(resolveActiveDomain("erp.delta.com", domains)).toBeNull()
    expect(resolveActiveDomain("erp.epsilon.com", domains)).toBeNull()
  })

  it("requires an EXACT host match — no suffix/prefix confusion", () => {
    expect(resolveActiveDomain("erp.acme.com.evil.com", domains)).toBeNull()
    expect(resolveActiveDomain("evil-erp.acme.com", domains)).toBeNull()
    expect(resolveActiveDomain("acme.com", domains)).toBeNull()
    expect(resolveActiveDomain("xerp.acme.com", domains)).toBeNull()
  })

  it("returns null for unknown or garbage hosts", () => {
    expect(resolveActiveDomain("unknown.com", domains)).toBeNull()
    expect(resolveActiveDomain("", domains)).toBeNull()
    expect(resolveActiveDomain("///", domains)).toBeNull()
    expect(resolveActiveDomain(null, domains)).toBeNull()
  })
})

describe("dnsInstructions", () => {
  it("emits the ownership TXT and routing CNAME records", () => {
    const token = "abc123"
    const records = dnsInstructions("erp.acme.com", token)
    const txt = records.find((r) => r.type === "TXT")!
    const cname = records.find((r) => r.type === "CNAME")!

    expect(txt.host).toBe(`${VERIFICATION_TXT_HOST}.erp.acme.com`)
    expect(txt.value).toBe(`${VERIFICATION_VALUE_PREFIX}${token}`)
    expect(verificationTxtValue(token)).toBe(txt.value)

    expect(cname.host).toBe("erp.acme.com")
    expect(cname.value).toBe(DOMAIN_CNAME_TARGET)
  })
})

describe("newVerificationToken", () => {
  it("returns a 48-char hex token that is unique per call", () => {
    const a = newVerificationToken()
    const b = newVerificationToken()
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    expect(a).not.toBe(b)
  })
})

describe("canTransitionTo — activation lifecycle guard", () => {
  it("only allows going active from verified or disabled", () => {
    expect(canTransitionTo("verified", "active")).toBe(true)
    expect(canTransitionTo("disabled", "active")).toBe(true)
    expect(canTransitionTo("pending", "active")).toBe(false)
    expect(canTransitionTo("failed", "active")).toBe(false)
  })
  it("allows deactivating an active or verified domain", () => {
    expect(canTransitionTo("active", "disabled")).toBe(true)
    expect(canTransitionTo("verified", "disabled")).toBe(true)
    expect(canTransitionTo("pending", "disabled")).toBe(false)
  })
})
