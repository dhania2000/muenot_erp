import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec 9 — tenant integration secret STORE orchestration (#20-21, #115-117).
 *
 * The store is the single place a tenant's OWN integration secrets are read and
 * written. These tests drive it with:
 *   - a real `@/lib/tenant-scope` (so every emitted statement carries the real
 *     tenant predicate) over a mocked `@/lib/db` that records + synthesizes;
 *   - a partially-mocked provider factory so the fallback path can be exercised
 *     deterministically without a real cloud call.
 *
 * They prove: encryption at rest + no plaintext column, tenant scoping on every
 * statement (cross-tenant reads are impossible by construction), rotation
 * versioning, rollback reactivation, provider-outage fallback to the encrypted
 * DB vault with a visible down/degraded health, idempotent retries, and an
 * append-only audit trail.
 */

// --- controllable tenant context ------------------------------------------
let CURRENT = 7
vi.mock("@/lib/tenant-context", () => ({
  requireCurrentTenantId: () => CURRENT,
  getCurrentTenant: () => ({ tenantId: CURRENT }),
  setCurrentTenant: vi.fn(),
}))

// --- recording + synthesizing DB -------------------------------------------
type Call = { sql: string; params: any[] }
const calls: Call[] = []
let selectQueue: any[][] = []
let insertSeq = 0

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    const head = sql.trim().slice(0, 6).toUpperCase()
    if (head === "SELECT") return selectQueue.length ? selectQueue.shift() : []
    if (head === "INSERT") return { insertId: ++insertSeq, affectedRows: 1 }
    if (head === "UPDATE") return { affectedRows: 1 }
    return [] // CREATE TABLE etc.
  }),
}))

// --- provider factory: real DB vault + crypto, injectable external ----------
const failingProvider = {
  kind: "aws_secrets_manager" as const,
  putSecret: vi.fn(async () => {
    throw new Error("network unreachable")
  }),
  getSecret: vi.fn(async () => {
    throw new Error("network unreachable")
  }),
  probe: vi.fn(async () => ({ ok: false as const })),
}
let externalOutage = false

vi.mock("@/lib/secrets/providers", async (importActual) => {
  const actual = (await importActual()) as any
  return {
    ...actual,
    configuredDefaultVaultKind: () => (externalOutage ? "aws_secrets_manager" : null),
    isVaultConfigured: (kind: string) => (kind === "db" ? true : externalOutage),
    buildVaultProvider: (kind: string) =>
      kind === "db" ? actual.getDatabaseVault() : externalOutage ? failingProvider : null,
  }
})

import { decryptSecret } from "@/lib/secrets/crypto"
import {
  getIntegrationAudit,
  getIntegrationsOverview,
  resolveIntegrationSecret,
  rollbackIntegrationSecret,
  rotateIntegrationSecret,
  setIntegrationSecret,
} from "@/lib/secrets/tenant-integration-store"

const ACTOR = { userId: 42, email: "admin@tenant.test" }

function insertsInto(table: string): Call[] {
  return calls.filter((c) => c.sql.includes(`INSERT INTO \`${table}\``))
}
function parseInsert(call: Call): Record<string, any> {
  const cols = call.sql.match(/INSERT INTO `[^`]+`\s*\(([^)]*)\)/)![1].split(",").map((s) => s.trim().replace(/`/g, ""))
  const row: Record<string, any> = {}
  cols.forEach((c, i) => (row[c] = call.params[i]))
  return row
}

beforeEach(() => {
  calls.length = 0
  selectQueue = []
  insertSeq = 0
  CURRENT = 7
  externalOutage = false
  failingProvider.putSecret.mockClear()
  failingProvider.probe.mockClear()
  process.env.SETTINGS_ENCRYPTION_KEY = "unit-test-master-key"
})
afterEach(() => {
  delete process.env.SETTINGS_ENCRYPTION_KEY
})

describe("set / rotate — encryption at rest + versioning", () => {
  it("stores the first version encrypted in the DB vault (no plaintext column)", async () => {
    selectQueue = [[] /* loadVersionRows */]
    const out = await setIntegrationSecret({
      integrationKey: "stripe",
      fieldKey: "secret_key",
      value: "sk_live_abc123",
      vaultChoice: null,
      actor: ACTOR,
    })
    expect(out).toMatchObject({ version: 1, vaultKind: "db", deduped: false })

    const versionRow = parseInsert(insertsInto("tenant_integration_secret_versions")[0])
    expect(versionRow.version).toBe(1)
    expect(versionRow.vault_kind).toBe("db")
    expect(versionRow.tenant_id).toBe(7)
    // The column holds an AES-GCM envelope, never the plaintext.
    expect(String(versionRow.provider_version)).not.toContain("sk_live_abc123")
    expect(decryptSecret(versionRow.provider_version)).toBe("sk_live_abc123")
  })

  it("rotation appends the next version and retires the previous active one", async () => {
    selectQueue = [[{ version: 1, vault_kind: "db", is_active: 1, created_at: "t", retired_at: null }]]
    const out = await rotateIntegrationSecret({
      integrationKey: "stripe",
      fieldKey: "secret_key",
      value: "sk_live_rotated",
      vaultChoice: null,
      actor: ACTOR,
    })
    expect(out.version).toBe(2)
    // A retire UPDATE targeting the active row was emitted before the insert.
    const retire = calls.find((c) => c.sql.startsWith("UPDATE") && c.sql.includes("is_active = 1"))
    expect(retire).toBeTruthy()
    expect(retire!.params).toContain(7) // tenant-scoped
  })

  it("rejects an empty value and an invalid field (server-side validation)", async () => {
    await expect(
      setIntegrationSecret({ integrationKey: "stripe", fieldKey: "secret_key", value: "", vaultChoice: null, actor: ACTOR }),
    ).rejects.toThrow(/empty/)
    await expect(
      setIntegrationSecret({ integrationKey: "stripe", fieldKey: "not_a_field", value: "x", vaultChoice: null, actor: ACTOR }),
    ).rejects.toThrow(/Invalid field/)
  })

  it("refuses to store a secret when encryption is not configured", async () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY
    selectQueue = [[]]
    await expect(
      setIntegrationSecret({ integrationKey: "stripe", fieldKey: "secret_key", value: "x", vaultChoice: null, actor: ACTOR }),
    ).rejects.toThrow(/SETTINGS_ENCRYPTION_KEY/)
  })
})

describe("provider outage — fail-closed fallback to the encrypted DB vault", () => {
  it("stores in the DB vault and records a down health when the external write fails", async () => {
    externalOutage = true // default external vault configured but unreachable
    selectQueue = [[] /* loadVersionRows */]
    const out = await setIntegrationSecret({
      integrationKey: "stripe",
      fieldKey: "secret_key",
      value: "sk_live_outage",
      vaultChoice: null,
      actor: ACTOR,
    })
    expect(failingProvider.putSecret).toHaveBeenCalled() // it TRIED the external vault
    expect(out.vaultKind).toBe("db") // ...then fell back
    expect(out.health).toBe("down")

    const versionRow = parseInsert(insertsInto("tenant_integration_secret_versions")[0])
    expect(versionRow.vault_kind).toBe("db")
    expect(decryptSecret(versionRow.provider_version)).toBe("sk_live_outage") // never dropped, never plaintext
  })
})

describe("rollback — reactivate a prior version (append-only)", () => {
  const versions = [
    { version: 1, vault_kind: "db", is_active: 0, created_at: "t1", retired_at: "t2" },
    { version: 2, vault_kind: "db", is_active: 1, created_at: "t2", retired_at: null },
  ]

  it("reactivates the target version and reports the prior active as fromVersion", async () => {
    selectQueue = [versions]
    const out = await rollbackIntegrationSecret({ integrationKey: "stripe", fieldKey: "secret_key", targetVersion: 1, actor: ACTOR })
    expect(out).toMatchObject({ version: 1, fromVersion: 2 })
    // Two updates: retire the active, then activate the target.
    const updates = calls.filter((c) => c.sql.startsWith("UPDATE"))
    expect(updates.length).toBe(2)
    expect(updates[1].params).toContain(1) // targetVersion
    expect(updates[1].params).toContain(7) // tenant-scoped
    const audit = parseInsert(insertsInto("tenant_integration_secret_audit").at(-1)!)
    expect(audit.action).toBe("rollback")
  })

  it("rejects a rollback to a non-existent version (no rows mutated)", async () => {
    selectQueue = [versions]
    await expect(
      rollbackIntegrationSecret({ integrationKey: "stripe", fieldKey: "secret_key", targetVersion: 99, actor: ACTOR }),
    ).rejects.toThrow(/does not exist/)
    expect(calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false)
  })

  it("rejects a rollback to the already-active version (no-op)", async () => {
    selectQueue = [versions]
    await expect(
      rollbackIntegrationSecret({ integrationKey: "stripe", fieldKey: "secret_key", targetVersion: 2, actor: ACTOR }),
    ).rejects.toThrow(/already active/)
  })
})

describe("idempotency — a retry with the same key collapses to one version", () => {
  it("returns the previously recorded version without writing a new one", async () => {
    // First SELECT = idempotency lookup returns a prior result; second = version rows.
    selectQueue = [[{ result_version: 5 }], [{ version: 5, vault_kind: "db" }]]
    const out = await setIntegrationSecret({
      integrationKey: "stripe",
      fieldKey: "secret_key",
      value: "sk_live_retry",
      vaultChoice: null,
      actor: ACTOR,
      idempotencyKey: "abc-123",
    })
    expect(out).toMatchObject({ version: 5, deduped: true })
    // No new version row was inserted on the deduped path.
    expect(insertsInto("tenant_integration_secret_versions").length).toBe(0)
  })
})

describe("cross-tenant isolation — reads are bound to the session tenant", () => {
  it("resolveIntegrationSecret scopes the active-version SELECT to the current tenant", async () => {
    CURRENT = 7
    selectQueue = [[]] // no active version for tenant 7
    const value = await resolveIntegrationSecret("stripe", "secret_key", ACTOR)
    expect(value).toBeNull()
    const sel = calls.find((c) => c.sql.includes("FROM `tenant_integration_secret_versions`") && c.sql.includes("SELECT vault_kind"))!
    expect(sel.sql).toContain("`tenant_id` = ?")
    expect(sel.params[0]).toBe(7) // tenant comes from the session, not from any caller input
  })

  it("a different session tenant emits a different tenant predicate (no shared rows)", async () => {
    CURRENT = 8
    selectQueue = [[{ vault_kind: "db", provider_version: "irrelevant", provider_ref: null }]]
    // The read is scoped to tenant 8; there is no API surface to request tenant 7's row.
    await resolveIntegrationSecret("stripe", "secret_key", ACTOR).catch(() => null)
    const sel = calls.find((c) => c.sql.includes("SELECT vault_kind"))!
    expect(sel.params[0]).toBe(8)
  })
})

describe("audit history — tenant-scoped, newest first", () => {
  it("maps rows and always constrains by tenant + optional integration filter", async () => {
    selectQueue = [
      [
        { id: 3, integration_key: "stripe", field_key: "secret_key", action: "set", actor_email: "a@t.test", detail: "version 1 → db", created_at: "2026-06-01" },
        { id: 2, integration_key: "stripe", field_key: "secret_key", action: "test", actor_email: "a@t.test", detail: "vault=db health=healthy", created_at: "2026-05-01" },
      ],
    ]
    const events = await getIntegrationAudit({ integrationKey: "stripe", limit: 50 })
    expect(events.map((e) => e.action)).toEqual(["set", "test"])
    const sel = calls.find((c) => c.sql.includes("FROM `tenant_integration_secret_audit`"))!
    expect(sel.sql).toContain("`tenant_id` = ?")
    expect(sel.params[0]).toBe(7)
    expect(sel.params).toContain("stripe")
  })
})

describe("overview — masked, plaintext-free projection", () => {
  it("returns every catalogue integration with masked fields and no value column", async () => {
    selectQueue = [
      [{ integration_key: "stripe", vault_kind: "db", health_state: "healthy", last_tested_at: null, last_rotated_at: null }],
      [{ integration_key: "stripe", field_key: "secret_key", version: 1, vault_kind: "db", created_at: "t" }],
    ]
    const overview = await getIntegrationsOverview()
    const stripe = overview.find((i) => i.key === "stripe")!
    const secret = stripe.fields.find((f) => f.key === "secret_key")!
    expect(secret.present).toBe(true)
    expect(secret.masked).toBe("••••••••")
    expect("value" in (secret as Record<string, unknown>)).toBe(false)
    // Overview SELECTs are tenant-scoped.
    const sel = calls.find((c) => c.sql.includes("FROM `tenant_integration_secrets`"))!
    expect(sel.params[0]).toBe(7)
  })
})
