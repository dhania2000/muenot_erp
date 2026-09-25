import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec 15 — Integration marketplace STORE orchestration (#88-89).
 *
 * The store is the single place a tenant's connector installs + credentials are
 * read and written. It is driven here with a real `@/lib/tenant-scope` (so every
 * emitted statement carries the real tenant predicate) over a mocked `@/lib/db`
 * that records and synthesizes, plus a controllable tenant context.
 *
 * Proven: encryption at rest (no plaintext column), INSTALL ROLLBACK (a failed
 * readiness probe deletes every credential written in the attempt and records no
 * install), SECRET REVOCATION on disconnect, CROSS-TENANT boundaries (every
 * statement is scoped to the session tenant — a foreign tenant id is impossible
 * to reach), idempotent retries, and an append-only audit trail.
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
    if (head === "DELETE") return { affectedRows: 1 }
    return [] // CREATE TABLE etc.
  }),
}))

import { decryptSecret, encryptSecret } from "@/lib/secrets/crypto"
import {
  checkConnectorHealth,
  disconnectConnector,
  installConnector,
  reconnectConnector,
  resolveConnectorCredential,
} from "@/lib/marketplace/connector-store"

const ACTOR = { userId: 42, email: "admin@tenant.test" }

const TALLY_CREDS = { host: "192.168.0.10", port: "9000", auth_token: "tok-live" }

function insertsInto(table: string): Call[] {
  return calls.filter((c) => c.sql.startsWith("INSERT") && c.sql.includes(`INTO \`${table}\``))
}
function deletesFrom(table: string): Call[] {
  return calls.filter((c) => c.sql.startsWith("DELETE") && c.sql.includes(`FROM \`${table}\``))
}
function parseInsert(call: Call): Record<string, any> {
  const cols = call.sql
    .match(/INSERT INTO `[^`]+`\s*\(([^)]*)\)/)![1]
    .split(",")
    .map((s) => s.trim().replace(/`/g, ""))
  const row: Record<string, any> = {}
  cols.forEach((c, i) => (row[c] = call.params[i]))
  return row
}
/** encrypted active-credential rows, as loadActiveCredentials expects them */
function encRows(creds: Record<string, string>) {
  return Object.entries(creds).map(([field_key, v]) => ({ field_key, ciphertext: encryptSecret(v) }))
}

beforeEach(() => {
  calls.length = 0
  selectQueue = []
  insertSeq = 0
  CURRENT = 7
  process.env.SETTINGS_ENCRYPTION_KEY = "unit-test-master-key"
})
afterEach(() => {
  delete process.env.SETTINGS_ENCRYPTION_KEY
  vi.clearAllMocks()
})

describe("install — encryption at rest, tenant stamping, audit", () => {
  it("stores each credential encrypted (no plaintext column) and records the install", async () => {
    selectQueue = [[] /* loadInstallation → not installed */]
    const out = await installConnector({ connectorKey: "tally", requestedScopes: null, credentials: TALLY_CREDS, actor: ACTOR })
    expect(out).toMatchObject({ status: "installed", health: "healthy", deduped: false })

    const credInserts = insertsInto("tenant_connector_credentials")
    expect(credInserts.length).toBe(3)
    for (const call of credInserts) {
      const row = parseInsert(call)
      expect(row.tenant_id).toBe(7) // stamped from the session, never from input
      expect(String(row.ciphertext)).not.toContain("tok-live")
    }
    // The token round-trips through the AES-GCM envelope.
    const tokenRow = parseInsert(credInserts.find((c) => parseInsert(c).field_key === "auth_token")!)
    expect(decryptSecret(tokenRow.ciphertext)).toBe("tok-live")

    // An install audit row was written for the acting tenant.
    const audit = parseInsert(insertsInto("tenant_connector_audit").at(-1)!)
    expect(audit.action).toBe("install")
    expect(audit.tenant_id).toBe(7)
    expect(audit.actor_user_id).toBe(42)
  })

  it("refuses to store credentials when encryption is not configured", async () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY
    await expect(
      installConnector({ connectorKey: "tally", requestedScopes: null, credentials: TALLY_CREDS, actor: ACTOR }),
    ).rejects.toThrow(/SETTINGS_ENCRYPTION_KEY/)
  })

  it("rejects an unknown connector before touching the database", async () => {
    await expect(
      installConnector({ connectorKey: "evil", requestedScopes: null, credentials: {}, actor: ACTOR }),
    ).rejects.toThrow(/Unknown connector/)
  })

  it("rejects an unknown requested scope (no privilege widening)", async () => {
    selectQueue = [[]]
    await expect(
      installConnector({ connectorKey: "tally", requestedScopes: ["root.everything"], credentials: TALLY_CREDS, actor: ACTOR }),
    ).rejects.toThrow(/Unknown scope/)
  })
})

describe("install ROLLBACK — a failed probe leaves no partial credential", () => {
  it("deletes every credential written in the attempt and records install_failed", async () => {
    selectQueue = [[] /* loadInstallation */]
    // Structurally valid (validation passes) but the reviewed adapter's probe
    // fails: a Slack bot token must start with xoxb-. Probe → down → rollback.
    await expect(
      installConnector({
        connectorKey: "slack",
        requestedScopes: null,
        credentials: { app_id: "A123", bot_token: "not-a-bot-token", signing_secret: "sig" },
        actor: ACTOR,
      }),
    ).rejects.toThrow(/bot token/)

    // All three credential rows written this attempt were hard-deleted...
    const deletes = deletesFrom("tenant_connector_credentials")
    expect(deletes.length).toBe(3)
    for (const d of deletes) expect(d.params).toContain(7) // tenant-scoped delete

    // ...and no install row flipped to "installed".
    const installUpserts = calls.filter(
      (c) => c.sql.startsWith("INSERT") && c.sql.includes("tenant_connector_installations"),
    )
    expect(installUpserts.length).toBe(0)

    // A failure was audited.
    const audit = parseInsert(insertsInto("tenant_connector_audit").at(-1)!)
    expect(audit.action).toBe("install_failed")
  })
})

describe("idempotency — a retry with the same key collapses to one effect", () => {
  it("returns the recorded state without writing a new credential", async () => {
    selectQueue = [
      [{ result_status: "installed" }] /* lookupIdempotent hit */,
      [{ status: "installed", granted_scopes: '["ledgers.read","vouchers.read"]', health_state: "healthy" }] /* loadInstallation */,
      [{ field_key: "host" }, { field_key: "auth_token" }] /* loadActiveCredentialFields */,
    ]
    const out = await installConnector({
      connectorKey: "tally",
      requestedScopes: null,
      credentials: TALLY_CREDS,
      actor: ACTOR,
      idempotencyKey: "retry-1",
    })
    expect(out.deduped).toBe(true)
    expect(out.status).toBe("installed")
    expect(insertsInto("tenant_connector_credentials").length).toBe(0)
  })
})

describe("disconnect — secret revocation with preserved history", () => {
  it("revokes every active credential and marks the install disconnected", async () => {
    selectQueue = [[{ status: "installed", granted_scopes: '["ledgers.read"]', health_state: "healthy" }]]
    const out = await disconnectConnector({ connectorKey: "tally", actor: ACTOR })
    expect(out).toMatchObject({ status: "disconnected", revoked: 1, deduped: false })

    // The revocation is an UPDATE flipping is_active off — not a DELETE (history
    // is preserved) — and it is scoped to the acting tenant.
    const revoke = calls.find(
      (c) => c.sql.startsWith("UPDATE") && c.sql.includes("tenant_connector_credentials"),
    )!
    expect(revoke.sql).toContain("is_active")
    expect(revoke.params).toContain(7)
    expect(deletesFrom("tenant_connector_credentials").length).toBe(0)
  })

  it("refuses to disconnect a connector that is not installed", async () => {
    selectQueue = [[] /* not installed */]
    await expect(disconnectConnector({ connectorKey: "tally", actor: ACTOR })).rejects.toThrow(/not installed/)
  })
})

describe("health — probes the reviewed adapter against stored credentials", () => {
  it("classifies a healthy probe and persists it", async () => {
    selectQueue = [
      [{ status: "installed", granted_scopes: '["ledgers.read","vouchers.read"]', health_state: "unknown" }] /* loadInstallation */,
      encRows(TALLY_CREDS) /* loadActiveCredentials */,
    ]
    const out = await checkConnectorHealth({ connectorKey: "tally", actor: ACTOR })
    expect(out.health).toBe("healthy")
    const audit = parseInsert(insertsInto("tenant_connector_audit").at(-1)!)
    expect(audit.action).toBe("health")
  })

  it("refuses a health check on a connector that is not installed", async () => {
    selectQueue = [[]]
    await expect(checkConnectorHealth({ connectorKey: "tally", actor: ACTOR })).rejects.toThrow(/not installed/)
  })
})

describe("reconnect — re-authenticate or reuse stored credentials", () => {
  it("rotates in supplied credentials and marks the connector installed again", async () => {
    selectQueue = [
      [{ status: "disconnected", granted_scopes: '["ledgers.read","vouchers.read"]', health_state: "unknown" }] /* loadInstallation */,
      encRows(TALLY_CREDS) /* loadActiveCredentials after write */,
    ]
    const out = await reconnectConnector({ connectorKey: "tally", requestedScopes: null, credentials: TALLY_CREDS, actor: ACTOR })
    expect(out).toMatchObject({ status: "installed", health: "healthy" })
    expect(insertsInto("tenant_connector_credentials").length).toBe(3)
  })

  it("fails closed when there are no stored credentials to reconnect with", async () => {
    selectQueue = [
      [{ status: "disconnected", granted_scopes: "[]", health_state: "unknown" }] /* loadInstallation */,
      [] /* loadActiveCredentials → none */,
    ]
    await expect(
      reconnectConnector({ connectorKey: "tally", requestedScopes: null, credentials: null, actor: ACTOR }),
    ).rejects.toThrow(/Re-authentication required/)
  })
})

describe("cross-tenant isolation — reads are bound to the session tenant", () => {
  it("resolveConnectorCredential scopes the SELECT to the current tenant", async () => {
    CURRENT = 7
    selectQueue = [[{ ciphertext: encryptSecret("tok-live") }]]
    const value = await resolveConnectorCredential("tally", "auth_token", ACTOR)
    expect(value).toBe("tok-live")
    const sel = calls.find((c) => c.sql.includes("FROM `tenant_connector_credentials`") && c.sql.startsWith("SELECT"))!
    expect(sel.sql).toContain("`tenant_id` = ?")
    expect(sel.params[0]).toBe(7) // tenant comes from the session, not the caller
  })

  it("a different session tenant emits a different tenant predicate (no shared rows)", async () => {
    CURRENT = 8
    selectQueue = [[]] // tenant 8 has no such credential
    const value = await resolveConnectorCredential("tally", "auth_token", ACTOR)
    expect(value).toBeNull()
    const sel = calls.find((c) => c.sql.includes("FROM `tenant_connector_credentials`") && c.sql.startsWith("SELECT"))!
    expect(sel.params[0]).toBe(8)
  })
})
