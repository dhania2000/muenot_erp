import { describe, expect, it } from "vitest"
import {
  CONNECTORS,
  type ConnectorState,
  assertNoConnectorSecretExposure,
  canTransition,
  deriveConnectorIdempotencyKey,
  getConnector,
  isKnownConnector,
  listConnectorKeys,
  resolveGrantedScopes,
  reviewConnectorPermissions,
  toPublicConnector,
  validateConnectorCredentials,
} from "@/lib/marketplace/connectors"
import { getAdapter } from "@/lib/marketplace/adapters"

/**
 * Spec 15 — Integration marketplace PURE model + reviewed adapters (#88-89).
 *
 * The connector catalogue and its common manifest are DB-free, network-free
 * rules the store + API + UI build on. These tests pin: catalogue integrity and
 * that every connector is backed by a REVIEWED adapter (no dynamic dispatch on
 * tenant input), scope + credential validation, the install lifecycle state
 * machine, the masked (plaintext-free) projection and its no-exposure guard,
 * tenant-scoped idempotency-key derivation, and each adapter's offline probe.
 */

describe("catalogue integrity + common manifest", () => {
  it("ships exactly the five curated connectors", () => {
    expect(listConnectorKeys().sort()).toEqual(["google", "microsoft", "slack", "tally", "zoho"])
  })

  it("keys are unique and every connector conforms to the common manifest", () => {
    const keys = CONNECTORS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of CONNECTORS) {
      expect(c.scopes.length).toBeGreaterThan(0)
      expect(c.credentials.length).toBeGreaterThan(0)
      expect(c.events.length).toBeGreaterThan(0)
      // Every scope/credential/event key is well-formed.
      for (const s of c.scopes) expect(s.key).toMatch(/^[a-z][a-z0-9_.:]*$/)
      for (const f of c.credentials) expect(f.key).toMatch(/^[a-z][a-z0-9_]*$/)
      for (const e of c.events) expect(e.key).toMatch(/^[a-z][a-z0-9_.]*$/)
      // Every required credential must exist and at least one scope is required.
      expect(c.credentials.some((f) => f.required)).toBe(true)
      expect(c.scopes.some((s) => s.required)).toBe(true)
    }
  })

  it("every connector is backed by a REVIEWED adapter (no tenant-selected code)", () => {
    for (const c of CONNECTORS) {
      expect(getAdapter(c.adapter)).not.toBeNull()
    }
    // An unknown adapter key resolves to null — the store treats that as a hard
    // error rather than executing anything dynamic.
    expect(getAdapter("../etc/passwd")).toBeNull()
    expect(getAdapter("__proto__")).toBeNull()
    expect(getAdapter("does-not-exist")).toBeNull()
  })

  it("lookup helpers agree with the catalogue", () => {
    expect(isKnownConnector("slack")).toBe(true)
    expect(isKnownConnector("not_a_connector")).toBe(false)
    expect(getConnector("slack")?.category).toBe("communication")
    expect(getConnector("nope")).toBeNull()
  })
})

describe("scope resolution — required always, optional opt-in, unknown rejected", () => {
  it("always includes required scopes even when nothing is requested", () => {
    const res = resolveGrantedScopes("google", null)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.granted).toEqual(["userinfo.email", "offline_access"])
  })

  it("adds requested optional scopes, manifest-ordered and de-duplicated", () => {
    const res = resolveGrantedScopes("slack", ["users:read", "users:read"])
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.granted).toEqual(["chat:write", "channels:read", "users:read"])
  })

  it("rejects a scope not declared by the manifest (no privilege widening)", () => {
    const res = resolveGrantedScopes("slack", ["admin:everything"])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Unknown scope/)
  })

  it("rejects an unknown connector", () => {
    const res = resolveGrantedScopes("nope", null)
    expect(res.ok).toBe(false)
  })
})

describe("credential validation", () => {
  it("accepts a complete set and returns the non-empty supplied keys", () => {
    const res = validateConnectorCredentials("tally", {
      host: "192.168.0.10",
      port: "9000",
      company_name: "",
      auth_token: "tok",
    })
    expect(res.ok).toBe(true)
    // company_name is empty → excluded; the rest persist.
    if (res.ok) expect(res.keys.sort()).toEqual(["auth_token", "host", "port"])
  })

  it("rejects a missing required field", () => {
    const res = validateConnectorCredentials("tally", { host: "h", port: "9000" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/required/)
  })

  it("rejects an undeclared credential field", () => {
    const res = validateConnectorCredentials("slack", {
      app_id: "A",
      bot_token: "xoxb-1",
      signing_secret: "s",
      rogue_field: "x",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Unknown credential field/)
  })
})

describe("install lifecycle state machine", () => {
  it("install: allowed from not_installed / disconnected, blocked when installed", () => {
    expect(canTransition("not_installed", "install").ok).toBe(true)
    expect(canTransition("disconnected", "install").ok).toBe(true)
    expect(canTransition("installed", "install").ok).toBe(false)
  })

  it("reconnect: blocked only when never installed", () => {
    expect(canTransition("not_installed", "reconnect").ok).toBe(false)
    expect(canTransition("installed", "reconnect").ok).toBe(true)
    expect(canTransition("disconnected", "reconnect").ok).toBe(true)
  })

  it("disconnect + health: only meaningful while installed", () => {
    expect(canTransition("installed", "disconnect").ok).toBe(true)
    expect(canTransition("disconnected", "disconnect").ok).toBe(false)
    expect(canTransition("installed", "health").ok).toBe(true)
    expect(canTransition("not_installed", "health").ok).toBe(false)
  })
})

describe("permission review projection", () => {
  it("marks which manifest scopes are currently granted", () => {
    const review = reviewConnectorPermissions("slack", ["chat:write", "channels:read"])
    const byKey = Object.fromEntries(review.map((r) => [r.key, r]))
    expect(byKey["chat:write"].granted).toBe(true)
    expect(byKey["chat:write"].required).toBe(true)
    expect(byKey["users:read"].granted).toBe(false)
  })

  it("returns an empty review for an unknown connector", () => {
    expect(reviewConnectorPermissions("nope", [])).toEqual([])
  })
})

describe("masked public projection — never carries a value", () => {
  const state = (over: Partial<ConnectorState> = {}): ConnectorState => ({
    status: "installed",
    health: "healthy",
    grantedScopes: ["chat:write", "channels:read"],
    presentCredentials: ["app_id", "bot_token"],
    installedAt: "2027-01-08T00:00:00Z",
    lastConnectedAt: "2027-01-08T00:00:00Z",
    lastHealthAt: null,
    lastError: null,
    ...over,
  })

  it("reports present flags for held credentials without exposing plaintext", () => {
    const pub = toPublicConnector(getConnector("slack")!, state())
    const botToken = pub.credentials.find((f) => f.key === "bot_token")!
    const signing = pub.credentials.find((f) => f.key === "signing_secret")!
    expect(botToken.present).toBe(true)
    expect(botToken.secret).toBe(true)
    expect(signing.present).toBe(false)
    for (const f of pub.credentials) {
      expect("value" in (f as Record<string, unknown>)).toBe(false)
      expect("plaintext" in (f as Record<string, unknown>)).toBe(false)
    }
  })

  it("assertNoConnectorSecretExposure passes a clean set and catches a leak", () => {
    const clean = CONNECTORS.map((c) => toPublicConnector(c, state()))
    expect(assertNoConnectorSecretExposure(clean)).toBe(true)

    const leaked = [toPublicConnector(getConnector("slack")!, state())]
    ;(leaked[0].credentials[0] as Record<string, unknown>).value = "xoxb-leaked"
    expect(() => assertNoConnectorSecretExposure(leaked)).toThrow(/exposed a plaintext credential/)
  })
})

describe("idempotency-key derivation — tenant scoped", () => {
  it("is deterministic and includes tenant/connector/action", () => {
    const a = deriveConnectorIdempotencyKey({ tenantId: 7, connectorKey: "slack", action: "install" })
    const b = deriveConnectorIdempotencyKey({ tenantId: 7, connectorKey: "slack", action: "install" })
    expect(a).toBe(b)
    expect(a).toBe("7:slack:install")
  })

  it("cannot collapse two tenants' actions together", () => {
    const t7 = deriveConnectorIdempotencyKey({ tenantId: 7, connectorKey: "slack", action: "install", clientKey: "abc" })
    const t8 = deriveConnectorIdempotencyKey({ tenantId: 8, connectorKey: "slack", action: "install", clientKey: "abc" })
    expect(t7).not.toBe(t8)
    expect(t7).toBe("7:slack:install:abc")
  })
})

describe("reviewed adapters — offline readiness probes", () => {
  it("tally validates host/port/auth_token", async () => {
    const a = getAdapter("tally")!
    expect((await a.probe({ credentials: { host: "h", port: "9000", auth_token: "t" }, grantedScopes: [] })).ok).toBe(true)
    expect((await a.probe({ credentials: { host: "", port: "9000", auth_token: "t" }, grantedScopes: [] })).ok).toBe(false)
    expect((await a.probe({ credentials: { host: "h", port: "70000", auth_token: "t" }, grantedScopes: [] })).ok).toBe(false)
    expect((await a.probe({ credentials: { host: "h", port: "abc", auth_token: "t" }, grantedScopes: [] })).ok).toBe(false)
  })

  it("zoho requires a valid data-center region", async () => {
    const a = getAdapter("zoho")!
    const base = { client_id: "c", client_secret: "s", refresh_token: "r" }
    expect((await a.probe({ credentials: { ...base, region: "in" }, grantedScopes: [] })).ok).toBe(true)
    expect((await a.probe({ credentials: { ...base, region: "mars" }, grantedScopes: [] })).ok).toBe(false)
  })

  it("slack insists on an xoxb- bot token", async () => {
    const a = getAdapter("slack")!
    const base = { app_id: "A", signing_secret: "s" }
    expect((await a.probe({ credentials: { ...base, bot_token: "xoxb-123" }, grantedScopes: [] })).ok).toBe(true)
    expect((await a.probe({ credentials: { ...base, bot_token: "not-a-bot-token" }, grantedScopes: [] })).ok).toBe(false)
  })

  it("microsoft + google require their OAuth credentials", async () => {
    const ms = getAdapter("microsoft")!
    expect((await ms.probe({ credentials: { directory_tenant_id: "t", client_id: "c", client_secret: "s" }, grantedScopes: [] })).ok).toBe(true)
    expect((await ms.probe({ credentials: { directory_tenant_id: "", client_id: "c", client_secret: "s" }, grantedScopes: [] })).ok).toBe(false)

    const g = getAdapter("google")!
    expect((await g.probe({ credentials: { client_id: "c", client_secret: "s", refresh_token: "r" }, grantedScopes: [] })).ok).toBe(true)
    expect((await g.probe({ credentials: { client_id: "c", client_secret: "s", refresh_token: "" }, grantedScopes: [] })).ok).toBe(false)
  })
})
