import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query }))
vi.mock("@/lib/comms-governance/schema", () => ({ ensureCommsGovernanceSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/email-engine/schema", () => ({ ensureEmailEngineSchema: vi.fn().mockResolvedValue(undefined) }))

import {
  addSuppression,
  guardOutbound,
  ingestEmailEvents,
  releaseSuppression,
  reserveSendSlot,
  saveProviderConfig,
} from "@/lib/comms-governance/service"

/**
 * Spec41 — governance service. Every statement is tenant-scoped, so these tests
 * assert both the decision AND that a tenant_id predicate is always bound. The
 * DB is mocked so we exercise the exact SQL/branching: version conflicts,
 * rate-limit reservation, consent locks, and duplicate/legacy event ingestion.
 */

/** Route a query by SQL fragment; unmatched writes succeed, reads return []. */
function route(handlers: { match: RegExp; result: unknown }[]) {
  m.query.mockImplementation(async (sql: string) => {
    for (const h of handlers) if (h.match.test(sql)) return h.result
    if (/^\s*SELECT/i.test(sql)) return []
    return { affectedRows: 1 }
  })
}

/** Every call must bind the acting tenant id as a parameter. */
function everyCallBoundTenant(tenantId: number) {
  for (const call of m.query.mock.calls) {
    const args = (call[1] ?? []) as unknown[]
    expect(args, `tenant ${tenantId} missing in: ${call[0]}`).toContain(tenantId)
  }
}

beforeEach(() => {
  m.query.mockReset()
})

describe("saveProviderConfig — optimistic concurrency + audit", () => {
  it("rejects a stale version instead of overwriting", async () => {
    route([{ match: /UPDATE tenant_comm_providers/, result: { affectedRows: 0 } }])
    await expect(
      saveProviderConfig(7, 1, { channel: "email", provider: "ses", enabled: true, credentialRef: "vault:k", settings: {} }, 2),
    ).rejects.toThrow(/changed by someone else/)
  })

  it("creates a new config and audits it", async () => {
    route([
      { match: /INSERT IGNORE INTO tenant_comm_providers/, result: { affectedRows: 1 } },
      { match: /SELECT \* FROM tenant_comm_providers WHERE tenant_id=\? AND channel=\?/, result: [{ tenant_id: 7, channel: "email", provider: "ses", enabled: 1, version: 1 }] },
    ])
    const cfg = await saveProviderConfig(7, 1, { channel: "email", provider: "ses", enabled: true, credentialRef: "vault:k", settings: {} }, 0)
    expect(cfg).toMatchObject({ provider: "ses", enabled: true })
    expect(m.query.mock.calls.some((c) => /INSERT INTO tenant_comm_audit/.test(c[0]))).toBe(true)
    everyCallBoundTenant(7)
  })

  it("rejects an inline secret before touching the database", async () => {
    route([])
    await expect(
      saveProviderConfig(7, 1, { channel: "email", provider: "ses", enabled: true, settings: { api_key: "sk-live" } }, 0),
    ).rejects.toThrow(/secret/i)
  })
})

describe("guardOutbound — the single outbound gate", () => {
  it("blocks when the tenant provider is disabled", async () => {
    route([{ match: /SELECT \* FROM tenant_comm_providers/, result: [{ channel: "email", provider: "ses", enabled: 0, version: 1 }] }])
    const d = await guardOutbound(7, "email", "a@b.com")
    expect(d).toMatchObject({ ok: false, code: "provider_disabled" })
  })

  it("blocks a suppressed recipient", async () => {
    route([
      { match: /SELECT \* FROM tenant_comm_providers/, result: [{ channel: "email", provider: "ses", enabled: 1, version: 1 }] },
      { match: /FROM tenant_comm_suppressions/, result: [{ reason: "hard_bounce", hit_count: 1 }] },
    ])
    const d = await guardOutbound(7, "email", "a@b.com")
    expect(d).toMatchObject({ ok: false, code: "suppressed", reason: "hard_bounce" })
  })

  it("blocks with rate_limited when the hourly window is full", async () => {
    route([
      { match: /SELECT \* FROM tenant_comm_providers/, result: [{ channel: "email", provider: "ses", enabled: 1, hourly_limit: 5, version: 1 }] },
      { match: /UPDATE tenant_comm_send_counters SET sent=sent\+1/, result: { affectedRows: 0 } },
    ])
    const d = await guardOutbound(7, "email", "a@b.com")
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe("rate_limited")
    everyCallBoundTenant(7)
  })

  it("passes a clean recipient under an enabled provider", async () => {
    route([{ match: /SELECT \* FROM tenant_comm_providers/, result: [{ channel: "email", provider: "ses", enabled: 1, version: 1 }] }])
    expect(await guardOutbound(7, "email", "a@b.com")).toEqual({ ok: true })
  })
})

describe("reserveSendSlot — atomic windows", () => {
  it("rolls back the hourly reservation when the daily window is full", async () => {
    const seen: string[] = []
    m.query.mockImplementation(async (sql: string) => {
      seen.push(sql)
      if (/UPDATE tenant_comm_send_counters SET sent=sent\+1.*window_kind/.test(sql) === false && /SET sent=sent\+1/.test(sql)) {
        // hour bump succeeds, day bump fails — distinguish by the bound window kind is hard here;
      }
      return { affectedRows: 1 }
    })
    // hour ok, day fails: return 1 then 0 for the two conditional UPDATEs.
    let bump = 0
    m.query.mockImplementation(async (sql: string) => {
      if (/UPDATE tenant_comm_send_counters SET sent=sent\+1/.test(sql)) {
        bump++
        return { affectedRows: bump === 1 ? 1 : 0 }
      }
      return { affectedRows: 1 }
    })
    const res = await reserveSendSlot(7, "email", { channel: "email", provider: "ses", enabled: true, credentialRef: null, hourlyLimit: 10, dailyLimit: 100, settings: {}, version: 1, updatedAt: null })
    expect(res.ok).toBe(false)
    // The hour reservation must have been decremented back (unbump).
    expect(m.query.mock.calls.some((c) => /SET sent=GREATEST\(sent,1\)-1/.test(c[0]))).toBe(true)
  })

  it("no config means no tenant limit", async () => {
    route([])
    expect(await reserveSendSlot(7, "email", null)).toEqual({ ok: true })
    expect(m.query).not.toHaveBeenCalled()
  })
})

describe("suppression release — consent lock + cross-tenant", () => {
  it("refuses to lift a consent withdrawal (opt_out)", async () => {
    route([{ match: /SELECT id,channel,reason FROM tenant_comm_suppressions/, result: [{ id: 3, channel: "whatsapp", reason: "opt_out" }] }])
    await expect(releaseSuppression(7, 1, 3)).rejects.toThrow(/Only the recipient/)
  })

  it("treats a foreign / unknown id as not found (no cross-tenant lift)", async () => {
    route([{ match: /SELECT id,channel,reason FROM tenant_comm_suppressions/, result: [] }])
    await expect(releaseSuppression(7, 1, 999)).rejects.toThrow(/not found/i)
  })

  it("lifts a manual suppression and binds the tenant", async () => {
    route([{ match: /SELECT id,channel,reason FROM tenant_comm_suppressions/, result: [{ id: 3, channel: "email", reason: "manual" }] }])
    await releaseSuppression(7, 1, 3)
    expect(m.query.mock.calls.some((c) => /UPDATE tenant_comm_suppressions SET released_at/.test(c[0]))).toBe(true)
    everyCallBoundTenant(7)
  })
})

describe("addSuppression — idempotent upsert", () => {
  it("uses an ON DUPLICATE KEY upsert scoped to the tenant", async () => {
    route([])
    await addSuppression(7, { channel: "email", address: "a@b.com", reason: "hard_bounce", source: "provider:ses" })
    const insert = m.query.mock.calls.find((c) => /INSERT INTO tenant_comm_suppressions/.test(c[0]))
    expect(insert?.[0]).toMatch(/ON DUPLICATE KEY UPDATE/)
    expect((insert?.[1] as unknown[])[0]).toBe(7)
  })
})

describe("ingestEmailEvents — duplicate delivery + legacy attribution", () => {
  const sesHardBounce = {
    MessageId: "sns-1",
    Message: JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@b.com" }] },
      mail: { messageId: "msg-1" },
    }),
  }

  it("attributes to the owning tenant only via the platform's own message", async () => {
    route([
      { match: /FROM tenant_email_messages/, result: [{ id: 55, tenant_id: 7, to_email: "a@b.com" }] },
      { match: /INSERT IGNORE INTO tenant_comm_provider_events/, result: { affectedRows: 1 } },
    ])
    const res = await ingestEmailEvents("ses", sesHardBounce)
    expect(res).toMatchObject({ processed: 1, duplicates: 0, unattributed: 0 })
    // suppression + status update + event log all bound tenant 7.
    expect(m.query.mock.calls.some((c) => /INSERT INTO tenant_comm_suppressions/.test(c[0]) && (c[1] as unknown[])[0] === 7)).toBe(true)
  })

  it("drops a duplicate provider retry (same event id) as a duplicate", async () => {
    route([
      { match: /FROM tenant_email_messages/, result: [{ id: 55, tenant_id: 7, to_email: "a@b.com" }] },
      { match: /INSERT IGNORE INTO tenant_comm_provider_events/, result: { affectedRows: 0 } },
    ])
    const res = await ingestEmailEvents("ses", sesHardBounce)
    expect(res).toMatchObject({ processed: 0, duplicates: 1 })
  })

  it("counts an event it cannot attribute to a sent message as unattributed", async () => {
    route([{ match: /FROM tenant_email_messages/, result: [] }])
    const res = await ingestEmailEvents("ses", sesHardBounce)
    expect(res).toMatchObject({ processed: 0, unattributed: 1 })
  })

  it("never attributes when the recipient does not match the sent message", async () => {
    route([{ match: /FROM tenant_email_messages/, result: [{ id: 55, tenant_id: 7, to_email: "someone-else@b.com" }] }])
    const res = await ingestEmailEvents("ses", sesHardBounce)
    expect(res).toMatchObject({ unattributed: 1, processed: 0 })
  })
})
