import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec21 (#35) — WebAuthn store: single-use challenges (replay), cross-tenant
 * isolation, per-user lockout and admin revoke-all. The store talks to MySQL
 * only through `query`, so we back it with a tiny in-memory table model and
 * assert on the observable behaviour rather than the raw SQL.
 */

const mock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mock.query, pool: { getConnection: vi.fn() } }))

import {
  issueChallenge,
  consumeChallenge,
  saveCredential,
  findCredential,
  getCredentialById,
  listCredentials,
  revokeAllCredentials,
  recordAuthFailure,
  isLockedOut,
  clearAuthFailures,
  WEBAUTHN_LOCKOUT_THRESHOLD,
} from "@/lib/webauthn-store"
import type { StoredPublicKey } from "@/lib/webauthn/cose"

type ChallengeRow = {
  id: string
  tenant_id: number
  user_id: number
  purpose: string
  challenge: string
  origin: string
  rp_id: string
  expires_at: string
}
type CredRow = {
  id: number
  tenant_id: number
  user_id: number
  credential_id: string
  public_key: string
  sign_count: number
  transports: string | null
  label: string | null
  backed_up: number
  created_at: string
  last_used_at: string | null
}
type FailureRow = { tenant_id: number; user_id: number; reason: string; created_at: number }

let challenges: ChallengeRow[]
let creds: CredRow[]
let failures: FailureRow[]
let credAutoId: number

function installDb() {
  challenges = []
  creds = []
  failures = []
  credAutoId = 1

  mock.query.mockImplementation(async (sqlRaw: string, params: any[] = []) => {
    const sql = String(sqlRaw).replace(/\s+/g, " ").trim()

    if (sql.startsWith("CREATE TABLE")) return []

    // --- challenges ---------------------------------------------------------
    if (sql.startsWith("DELETE FROM `webauthn_challenges` WHERE expires_at < NOW()")) {
      challenges = challenges.filter((c) => new Date(c.expires_at).getTime() >= Date.now())
      return { affectedRows: 0 }
    }
    if (sql.includes("DELETE FROM `webauthn_challenges`") && sql.includes("WHERE tenant_id = ?")) {
      const [tenantId, userId, purpose] = params
      challenges = challenges.filter((c) => !(c.tenant_id === tenantId && c.user_id === userId && c.purpose === purpose))
      return { affectedRows: 0 }
    }
    if (sql.startsWith("INSERT INTO `webauthn_challenges`")) {
      const [id, tenant_id, user_id, purpose, challenge, origin, rp_id, expiresUnix] = params
      challenges.push({
        id,
        tenant_id,
        user_id,
        purpose,
        challenge,
        origin,
        rp_id,
        expires_at: new Date(Number(expiresUnix) * 1000).toISOString(),
      })
      return { affectedRows: 1 }
    }
    if (sql.startsWith("SELECT challenge, origin, rp_id, expires_at FROM `webauthn_challenges`")) {
      const [id, tenant_id, user_id, purpose] = params
      const row = challenges.find(
        (c) => c.id === id && c.tenant_id === tenant_id && c.user_id === user_id && c.purpose === purpose,
      )
      return row ? [{ challenge: row.challenge, origin: row.origin, rp_id: row.rp_id, expires_at: row.expires_at }] : []
    }
    if (sql.startsWith("DELETE FROM `webauthn_challenges`") && sql.includes("WHERE id = ?")) {
      const [id, tenant_id, user_id, purpose] = params
      const before = challenges.length
      challenges = challenges.filter(
        (c) => !(c.id === id && c.tenant_id === tenant_id && c.user_id === user_id && c.purpose === purpose),
      )
      return { affectedRows: before - challenges.length }
    }

    // --- credentials --------------------------------------------------------
    if (sql.startsWith("SELECT COUNT(*) AS n FROM `webauthn_credentials`") && sql.includes("credential_id = ?") && !sql.includes("tenant_id")) {
      const [credentialId] = params
      return [{ n: creds.filter((c) => c.credential_id === credentialId).length }]
    }
    if (sql.startsWith("SELECT COUNT(*) AS n FROM `webauthn_credentials`")) {
      const [tenant_id, user_id] = params
      return [{ n: creds.filter((c) => c.tenant_id === tenant_id && c.user_id === user_id).length }]
    }
    if (sql.startsWith("INSERT INTO `webauthn_credentials`")) {
      const [tenant_id, user_id, credential_id, public_key, sign_count, transports, label, backed_up] = params
      creds.push({
        id: credAutoId++,
        tenant_id,
        user_id,
        credential_id,
        public_key,
        sign_count,
        transports,
        label,
        backed_up,
        created_at: new Date().toISOString(),
        last_used_at: null,
      })
      return { affectedRows: 1 }
    }
    if (sql.startsWith("SELECT * FROM `webauthn_credentials`") && sql.includes("credential_id = ?")) {
      const [tenant_id, user_id, credential_id] = params
      return creds.filter((c) => c.tenant_id === tenant_id && c.user_id === user_id && c.credential_id === credential_id)
    }
    if (sql.startsWith("SELECT * FROM `webauthn_credentials`") && sql.includes("WHERE id = ?")) {
      const [id, tenant_id, user_id] = params
      return creds.filter((c) => c.id === id && c.tenant_id === tenant_id && c.user_id === user_id)
    }
    if (sql.startsWith("SELECT * FROM `webauthn_credentials`") && sql.includes("ORDER BY")) {
      const [tenant_id, user_id] = params
      return creds.filter((c) => c.tenant_id === tenant_id && c.user_id === user_id)
    }
    if (sql.startsWith("DELETE FROM `webauthn_credentials`") && sql.includes("WHERE id = ?")) {
      const [id, tenant_id, user_id] = params
      const before = creds.length
      creds = creds.filter((c) => !(c.id === id && c.tenant_id === tenant_id && c.user_id === user_id))
      return { affectedRows: before - creds.length }
    }
    if (sql.startsWith("DELETE FROM `webauthn_credentials`")) {
      const [tenant_id, user_id] = params
      const before = creds.length
      creds = creds.filter((c) => !(c.tenant_id === tenant_id && c.user_id === user_id))
      return { affectedRows: before - creds.length }
    }

    // --- auth failures ------------------------------------------------------
    if (sql.startsWith("SELECT COUNT(*) AS n FROM `webauthn_auth_failures`")) {
      const [tenant_id, user_id] = params
      return [{ n: failures.filter((f) => f.tenant_id === tenant_id && f.user_id === user_id).length }]
    }
    if (sql.startsWith("INSERT INTO `webauthn_auth_failures`")) {
      const [tenant_id, user_id, reason] = params
      failures.push({ tenant_id, user_id, reason, created_at: Date.now() })
      return { affectedRows: 1 }
    }
    if (sql.startsWith("DELETE FROM `webauthn_auth_failures`")) {
      const [tenant_id, user_id] = params
      failures = failures.filter((f) => !(f.tenant_id === tenant_id && f.user_id === user_id))
      return { affectedRows: 0 }
    }

    throw new Error(`Unhandled SQL in mock: ${sql}`)
  })
}

const PK: StoredPublicKey = { alg: -7, jwk: { kty: "EC", crv: "P-256", x: "aaa", y: "bbb" } }

beforeEach(() => {
  vi.clearAllMocks()
  installDb()
})

describe("Spec21 WebAuthn challenge single-use / replay", () => {
  it("consumes a challenge once and rejects the replay", async () => {
    const issued = await issueChallenge({ tenantId: 1, userId: 10, purpose: "authenticate", origin: "https://a", rpId: "a" })
    const first = await consumeChallenge({ id: issued.id, tenantId: 1, userId: 10, purpose: "authenticate" })
    expect(first).not.toBeNull()
    expect(first?.challenge).toBe(issued.challenge)
    const replay = await consumeChallenge({ id: issued.id, tenantId: 1, userId: 10, purpose: "authenticate" })
    expect(replay).toBeNull()
  })

  it("rejects a challenge presented for the wrong tenant or user", async () => {
    const issued = await issueChallenge({ tenantId: 1, userId: 10, purpose: "authenticate", origin: "https://a", rpId: "a" })
    expect(await consumeChallenge({ id: issued.id, tenantId: 2, userId: 10, purpose: "authenticate" })).toBeNull()
    expect(await consumeChallenge({ id: issued.id, tenantId: 1, userId: 99, purpose: "authenticate" })).toBeNull()
    // wrong purpose (register vs authenticate) also fails closed
    expect(await consumeChallenge({ id: issued.id, tenantId: 1, userId: 10, purpose: "register" })).toBeNull()
  })

  it("keeps at most one live challenge per (user, purpose)", async () => {
    const a = await issueChallenge({ tenantId: 1, userId: 10, purpose: "authenticate", origin: "https://a", rpId: "a" })
    const b = await issueChallenge({ tenantId: 1, userId: 10, purpose: "authenticate", origin: "https://a", rpId: "a" })
    // The first challenge was superseded, so only the newest can be consumed.
    expect(await consumeChallenge({ id: a.id, tenantId: 1, userId: 10, purpose: "authenticate" })).toBeNull()
    expect(await consumeChallenge({ id: b.id, tenantId: 1, userId: 10, purpose: "authenticate" })).not.toBeNull()
  })
})

describe("Spec21 WebAuthn credential cross-tenant isolation", () => {
  it("never resolves a credential across tenants or users", async () => {
    await saveCredential({
      tenantId: 1,
      userId: 10,
      credentialId: "cred-abc",
      publicKey: PK,
      signCount: 0,
      transports: ["usb"],
      label: "Key A",
      backedUp: false,
    })
    // owner can find it
    expect(await findCredential(1, 10, "cred-abc")).not.toBeNull()
    // another tenant with the same credential id string cannot
    expect(await findCredential(2, 10, "cred-abc")).toBeNull()
    // another user in the same tenant cannot
    expect(await findCredential(1, 11, "cred-abc")).toBeNull()
    // listing is tenant+user scoped
    expect((await listCredentials(1, 10)).length).toBe(1)
    expect((await listCredentials(2, 10)).length).toBe(0)
  })

  it("refuses to register the same authenticator credential id twice", async () => {
    const input = {
      tenantId: 1,
      userId: 10,
      credentialId: "cred-dup",
      publicKey: PK,
      signCount: 0,
      transports: [],
      label: null,
      backedUp: false,
    }
    expect(await saveCredential(input)).toEqual({ ok: true })
    // even a different user/tenant cannot silently rebind a used credential id
    expect(await saveCredential({ ...input, tenantId: 2, userId: 20 })).toEqual({ ok: false, reason: "duplicate" })
  })

  it("scopes admin revoke-all to the given tenant + user", async () => {
    for (const [t, u, id] of [[1, 10, "k1"], [1, 10, "k2"], [1, 11, "k3"], [2, 10, "k4"]] as const) {
      await saveCredential({ tenantId: t, userId: u, credentialId: id, publicKey: PK, signCount: 0, transports: [], label: null, backedUp: false })
    }
    const removed = await revokeAllCredentials(1, 10)
    expect(removed).toBe(2)
    expect((await listCredentials(1, 10)).length).toBe(0)
    // other user / other tenant untouched
    expect((await listCredentials(1, 11)).length).toBe(1)
    expect((await listCredentials(2, 10)).length).toBe(1)
  })

  it("row-id lookup is also tenant/user scoped", async () => {
    await saveCredential({ tenantId: 1, userId: 10, credentialId: "cred-row", publicKey: PK, signCount: 0, transports: [], label: null, backedUp: false })
    const [cred] = await listCredentials(1, 10)
    expect(await getCredentialById(1, 10, cred.id)).not.toBeNull()
    expect(await getCredentialById(2, 10, cred.id)).toBeNull()
    expect(await getCredentialById(1, 11, cred.id)).toBeNull()
  })
})

describe("Spec21 WebAuthn per-user lockout", () => {
  it("locks out after the failure threshold and clears on success", async () => {
    expect(await isLockedOut(1, 10)).toBe(false)
    for (let i = 0; i < WEBAUTHN_LOCKOUT_THRESHOLD - 1; i++) {
      await recordAuthFailure(1, 10, "bad_signature")
    }
    expect(await isLockedOut(1, 10)).toBe(false)
    await recordAuthFailure(1, 10, "bad_signature")
    expect(await isLockedOut(1, 10)).toBe(true)
    // lockout is per-user: a different user is unaffected
    expect(await isLockedOut(1, 11)).toBe(false)
    // a successful assertion clears the ledger
    await clearAuthFailures(1, 10)
    expect(await isLockedOut(1, 10)).toBe(false)
  })
})
