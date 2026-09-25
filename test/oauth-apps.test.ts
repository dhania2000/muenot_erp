import { beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "crypto"

// The store talks to MySQL through @/lib/db. We mock `query` and route each
// call by matching a distinctive fragment of its SQL, so the token issuance and
// verification flows can be exercised deterministically without a database.
const mock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock("@/lib/db", () => ({ query: mock.query }))

import {
  narrowScopes,
  looksLikeOAuthToken,
  toPublicApp,
  toPublicToken,
  issueClientCredentialsToken,
  verifyOAuthAccessToken,
  type OAuthAppRow,
  type OAuthTokenRow,
} from "@/lib/oauth/oauth-apps-store"
import { signWebhook, verifyWebhookSignature } from "@/lib/webhooks/signature"

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex")

function appRow(overrides: Partial<OAuthAppRow> = {}): OAuthAppRow {
  return {
    id: 1,
    tenant_id: 7,
    name: "Warehouse sync",
    description: null,
    client_id: "mnoa_client_abc",
    client_secret_hash: sha256("secret-current"),
    secret_hint: "rent",
    prev_secret_hash: null,
    prev_secret_expires_at: null,
    scopes: "clients:read,clients:write",
    token_ttl_seconds: 3600,
    status: "active",
    created_by: 5,
    created_at: "2026-01-01 00:00:00",
    revoked_at: null,
    ...overrides,
  } as OAuthAppRow
}

function tokenRow(overrides: Partial<OAuthTokenRow> = {}): OAuthTokenRow {
  return {
    id: 10,
    tenant_id: 7,
    app_id: 1,
    token_hash: sha256("mnoat_oat_x_deadbeef"),
    token_prefix: "oat_x",
    scopes: "clients:read",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    revoked_at: null,
    last_used_at: null,
    created_at: "2026-01-01 00:00:00",
    ...overrides,
  } as OAuthTokenRow
}

/** Route mock query calls by SQL fragment. `select` returns the app row. */
function routeQueries(handlers: {
  selectApp?: () => OAuthAppRow[]
  selectToken?: () => Array<OAuthTokenRow & { app_status: string; app_name: string }>
}) {
  mock.query.mockImplementation(async (sql: string) => {
    if (/CREATE TABLE/i.test(sql)) return []
    if (/FROM `oauth_apps` WHERE `client_id`/i.test(sql)) return handlers.selectApp ? handlers.selectApp() : []
    if (/FROM\s+`oauth_access_tokens`\s+t/i.test(sql) || /a\.`status` AS app_status/i.test(sql))
      return handlers.selectToken ? handlers.selectToken() : []
    if (/INSERT INTO `oauth_app_events`/i.test(sql)) return { insertId: 99 }
    if (/INSERT INTO `oauth_access_tokens`/i.test(sql)) return { insertId: 55 }
    if (/UPDATE `oauth_access_tokens`/i.test(sql)) return { affectedRows: 1 }
    return []
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe("narrowScopes — least-privilege scope enforcement", () => {
  const allowed = ["clients:read", "clients:write"]
  it("accepts a subset and deduplicates", () => {
    expect(narrowScopes(["clients:read", "clients:read"], allowed)).toEqual({ ok: true, scopes: ["clients:read"] })
  })
  it("rejects a scope beyond the granted set (wrong scope)", () => {
    const res = narrowScopes(["clients:read", "invoices:write"], allowed)
    expect(res).toEqual({ ok: false, invalid: ["invoices:write"] })
  })
  it("ignores blanks", () => {
    expect(narrowScopes(["  ", "clients:write"], allowed)).toEqual({ ok: true, scopes: ["clients:write"] })
  })
})

describe("public shapes never leak secrets", () => {
  it("toPublicApp omits secret hashes and computes rotation flag", () => {
    const pub = toPublicApp(
      appRow({ prev_secret_hash: sha256("old"), prev_secret_expires_at: new Date(Date.now() + 60_000).toISOString() }),
    )
    expect(pub).not.toHaveProperty("client_secret_hash")
    expect(pub).not.toHaveProperty("prev_secret_hash")
    expect(pub.scopeList).toEqual(["clients:read", "clients:write"])
    expect(pub.secretRotating).toBe(true)
  })
  it("toPublicToken omits the hash and marks expiry/active", () => {
    const expired = toPublicToken(tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() }))
    expect(expired).not.toHaveProperty("token_hash")
    expect(expired.active).toBe(false)
    const live = toPublicToken(tokenRow())
    expect(live.active).toBe(true)
  })
})

describe("looksLikeOAuthToken", () => {
  it("matches only the mnoat_ prefix", () => {
    expect(looksLikeOAuthToken("mnoat_oat_x_abc")).toBe(true)
    expect(looksLikeOAuthToken("mn_apikey")).toBe(false)
  })
})

describe("issueClientCredentialsToken — client-credentials grant", () => {
  it("rejects an unknown client uniformly as invalid_client", async () => {
    routeQueries({ selectApp: () => [] })
    const res = await issueClientCredentialsToken({ clientId: "nope", clientSecret: "x" })
    expect(res).toEqual({ ok: false, error: "invalid_client" })
  })

  it("rejects a wrong secret as invalid_client (indistinguishable from unknown client)", async () => {
    routeQueries({ selectApp: () => [appRow()] })
    const res = await issueClientCredentialsToken({ clientId: "mnoa_client_abc", clientSecret: "wrong" })
    expect(res).toEqual({ ok: false, error: "invalid_client" })
  })

  it("refuses to mint tokens for a revoked app", async () => {
    routeQueries({ selectApp: () => [appRow({ status: "revoked" })] })
    const res = await issueClientCredentialsToken({ clientId: "mnoa_client_abc", clientSecret: "secret-current" })
    expect(res).toEqual({ ok: false, error: "app_revoked" })
  })

  it("rejects a requested scope beyond consent (wrong scope)", async () => {
    routeQueries({ selectApp: () => [appRow()] })
    const res = await issueClientCredentialsToken({
      clientId: "mnoa_client_abc",
      clientSecret: "secret-current",
      requestedScopes: ["clients:read", "invoices:write"],
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe("invalid_scope")
  })

  it("mints a token narrowed to the requested subset, tenant taken from the app row", async () => {
    routeQueries({ selectApp: () => [appRow()] })
    const res = await issueClientCredentialsToken({
      clientId: "mnoa_client_abc",
      clientSecret: "secret-current",
      requestedScopes: ["clients:read"],
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.scope).toBe("clients:read")
      expect(res.tenantId).toBe(7) // isolation: comes from the stored app, never the caller
      expect(looksLikeOAuthToken(res.accessToken)).toBe(true)
    }
  })

  it("accepts the previous secret during the rotation grace window", async () => {
    routeQueries({
      selectApp: () => [
        appRow({
          client_secret_hash: sha256("secret-new"),
          prev_secret_hash: sha256("secret-old"),
          prev_secret_expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      ],
    })
    const res = await issueClientCredentialsToken({ clientId: "mnoa_client_abc", clientSecret: "secret-old" })
    expect(res.ok).toBe(true)
  })

  it("rejects the previous secret once the grace window has expired", async () => {
    routeQueries({
      selectApp: () => [
        appRow({
          client_secret_hash: sha256("secret-new"),
          prev_secret_hash: sha256("secret-old"),
          prev_secret_expires_at: new Date(Date.now() - 1000).toISOString(),
        }),
      ],
    })
    const res = await issueClientCredentialsToken({ clientId: "mnoa_client_abc", clientSecret: "secret-old" })
    expect(res).toEqual({ ok: false, error: "invalid_client" })
  })
})

describe("verifyOAuthAccessToken — bearer verification", () => {
  const token = "mnoat_oat_x_deadbeef"

  it("rejects a non-OAuth-shaped value without touching the DB", async () => {
    routeQueries({})
    const res = await verifyOAuthAccessToken("mn_something_else")
    expect(res).toEqual({ ok: false, reason: "unknown" })
    expect(mock.query).not.toHaveBeenCalled()
  })

  it("rejects an unknown token", async () => {
    routeQueries({ selectToken: () => [] })
    expect(await verifyOAuthAccessToken(token)).toEqual({ ok: false, reason: "unknown" })
  })

  it("rejects an expired token (token expiry)", async () => {
    routeQueries({
      selectToken: () => [
        { ...tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() }), app_status: "active", app_name: "A" },
      ],
    })
    expect(await verifyOAuthAccessToken(token)).toEqual({ ok: false, reason: "expired" })
  })

  it("rejects a revoked token (defeats replay of a leaked-then-revoked token)", async () => {
    routeQueries({
      selectToken: () => [
        { ...tokenRow({ revoked_at: new Date().toISOString() }), app_status: "active", app_name: "A" },
      ],
    })
    expect(await verifyOAuthAccessToken(token)).toEqual({ ok: false, reason: "revoked" })
  })

  it("rejects a token whose app was revoked", async () => {
    routeQueries({
      selectToken: () => [{ ...tokenRow(), app_status: "revoked", app_name: "A" }],
    })
    expect(await verifyOAuthAccessToken(token)).toEqual({ ok: false, reason: "app_revoked" })
  })

  it("returns the token's tenant from the stored row (cross-tenant isolation by construction)", async () => {
    routeQueries({
      selectToken: () => [{ ...tokenRow({ tenant_id: 42 }), app_status: "active", app_name: "Ops" }],
    })
    const res = await verifyOAuthAccessToken(token)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.token.tenantId).toBe(42)
      expect(res.token.scopes).toEqual(["clients:read"])
    }
  })
})

describe("webhook signatures", () => {
  const secret = "whsec_test"
  const body = JSON.stringify({ event: "client.created", id: 1 })
  const now = 1_700_000_000_000
  const ts = String(Math.floor(now / 1000))

  it("verifies a freshly signed payload", () => {
    const signature = signWebhook(secret, ts, body)
    expect(verifyWebhookSignature({ secret, timestamp: ts, body, signature, now })).toEqual({ ok: true })
  })

  it("rejects a tampered body", () => {
    const signature = signWebhook(secret, ts, body)
    expect(verifyWebhookSignature({ secret, timestamp: ts, body: body + " ", signature, now }).ok).toBe(false)
  })

  it("rejects a wrong secret", () => {
    const signature = signWebhook("other", ts, body)
    const res = verifyWebhookSignature({ secret, timestamp: ts, body, signature, now })
    expect(res).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("rejects a stale timestamp (replay protection)", () => {
    const oldTs = String(Math.floor(now / 1000) - 10_000)
    const signature = signWebhook(secret, oldTs, body)
    const res = verifyWebhookSignature({ secret, timestamp: oldTs, body, signature, now })
    expect(res).toEqual({ ok: false, reason: "stale_timestamp" })
  })

  it("rejects malformed input", () => {
    expect(verifyWebhookSignature({ secret, timestamp: null, body, signature: "x", now })).toEqual({
      ok: false,
      reason: "malformed",
    })
  })
})
