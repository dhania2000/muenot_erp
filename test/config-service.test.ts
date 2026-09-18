import { describe, expect, it } from "vitest"
import {
  CONFIG_REGISTRY,
  CONFIG_CATEGORIES,
  getDescriptor,
  type ConfigDescriptor,
} from "@/lib/config/registry"
import {
  assertNoSecretExposure,
  resolveConfigValue,
  toPublicEntry,
  type ResolvedConfigEntry,
} from "@/lib/config/resolve"

/**
 * SPEC 37 — Phase 4. Secret exposure and precedence.
 *
 * The configuration service is only as trustworthy as two invariants:
 *   (1) a deployment env value overrides a stored value overrides a default;
 *   (2) a secret plaintext never crosses the public projection.
 * Every case here frames the second as an attempted LEAK — a caller that hands
 * a secret through the resolver and inspects the shape that would be sent to a
 * client. If the projection fails closed here, the API and UI do too.
 */

const platformNonSecret = getDescriptor("platform.name")!
const platformSecret = getDescriptor("SESSION_SECRET")!
const tenantNonSecret = getDescriptor("app.currency")!
const envBacked = getDescriptor("APP_URL")!

function project(descriptor: ConfigDescriptor, layers: Parameters<typeof resolveConfigValue>[1]): ResolvedConfigEntry {
  return toPublicEntry(descriptor, resolveConfigValue(descriptor, layers))
}

describe("registry integrity", () => {
  it("every descriptor uses a known category and a valid scope", () => {
    for (const d of CONFIG_REGISTRY) {
      expect(CONFIG_CATEGORIES).toContain(d.category)
      expect(["platform", "tenant"]).toContain(d.scope)
    }
  })

  it("descriptor keys are unique", () => {
    const keys = CONFIG_REGISTRY.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("all eight SPEC 37 categories are represented", () => {
    const present = new Set(CONFIG_REGISTRY.map((d) => d.category))
    for (const c of CONFIG_CATEGORIES) expect(present.has(c)).toBe(true)
  })
})

describe("precedence: env > store > default", () => {
  it("uses the registry default when no layer provides a value", () => {
    const r = resolveConfigValue(platformNonSecret, {})
    expect(r.source).toBe("default")
    expect(r.value).toBe("Muenot")
  })

  it("a platform store value overrides the default", () => {
    const r = resolveConfigValue(platformNonSecret, { platform: "Acme Platform" })
    expect(r.source).toBe("platform")
    expect(r.value).toBe("Acme Platform")
  })

  it("a deployment env value overrides both store and default", () => {
    const r = resolveConfigValue(envBacked, { env: "https://prod.example.com", platform: "https://ignored" })
    expect(r.source).toBe("env")
    expect(r.value).toBe("https://prod.example.com")
  })

  it("a tenant store value wins for a tenant-scoped key, but env still overrides", () => {
    const stored = resolveConfigValue(tenantNonSecret, { tenant: "EUR" })
    expect(stored.source).toBe("tenant")
    expect(stored.value).toBe("EUR")

    const overridden = resolveConfigValue(tenantNonSecret, { tenant: "EUR", env: "USD" })
    expect(overridden.source).toBe("env")
    expect(overridden.value).toBe("USD")
  })

  it("ignores a cross-scope layer (platform value does not fill a tenant key)", () => {
    const r = resolveConfigValue(tenantNonSecret, { platform: "GBP" })
    expect(r.source).toBe("default")
    expect(r.value).toBe("INR")
  })

  it("treats blank/whitespace-only layer values as absent", () => {
    const r = resolveConfigValue(platformNonSecret, { platform: "   " })
    expect(r.source).toBe("default")
    expect(r.value).toBe("Muenot")
  })

  it("resolves to unset when there is no value and no default", () => {
    const r = resolveConfigValue(platformSecret, {})
    expect(r.source).toBe("unset")
    expect(r.value).toBeNull()
  })
})

describe("secret exposure (leak attempt: read a secret through the public shape)", () => {
  it("never carries a secret plaintext, even when env provides one", () => {
    const entry = project(platformSecret, { env: "super-secret-signing-key" })
    expect(entry.secret).toBe(true)
    expect(entry.hasValue).toBe(true)
    expect(entry.source).toBe("env")
    expect(entry.value).toBeNull()
    expect(entry.masked).toBe("••••••••")
    expect(entry.masked).not.toContain("super-secret")
  })

  it("shows a secret as not-set without inventing a value", () => {
    const entry = project(platformSecret, {})
    expect(entry.hasValue).toBe(false)
    expect(entry.source).toBe("unset")
    expect(entry.value).toBeNull()
    expect(entry.masked).toBe("not set")
  })

  it("still exposes non-secret values in the clear (they are safe to render)", () => {
    const entry = project(platformNonSecret, { platform: "Acme" })
    expect(entry.value).toBe("Acme")
    expect(entry.masked).toBe("Acme")
  })

  it("assertNoSecretExposure passes for a fully projected registry", () => {
    const entries = CONFIG_REGISTRY.map((d) =>
      // Feed every descriptor a value so secrets are 'present' — the hardest case.
      project(d, { env: "x-value", tenant: "x-value", platform: "x-value" }),
    )
    expect(assertNoSecretExposure(entries)).toBe(true)
  })

  it("assertNoSecretExposure throws if a secret plaintext ever slips through", () => {
    const tampered: ResolvedConfigEntry = {
      ...project(platformSecret, { env: "leak" }),
      value: "leak", // simulate a regression that forgot to strip the secret
    }
    expect(() => assertNoSecretExposure([tampered])).toThrow(/exposed a plaintext value/)
  })
})
