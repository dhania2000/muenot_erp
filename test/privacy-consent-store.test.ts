import { beforeEach, describe, expect, it, vi } from "vitest"
import { MiniSql } from "./helpers/mini-sql"

/**
 * Spec24 — consent & notice store (#155). Exercises the DB-backed ledger against
 * an in-memory engine that runs the store's real SQL: recording explicit
 * consent, withdrawing it (and the failure when there is nothing to withdraw),
 * that the CURRENT state collapses the event history correctly, cross-tenant
 * isolation, and that every mutation writes audit evidence.
 */

const db = new MiniSql()
const audit = vi.hoisted(() => ({ recordAuditLog: vi.fn(async () => {}) }))

vi.mock("@/lib/db", () => ({
  query: (sql: string, params?: any[]) => db.query(sql, params),
}))
vi.mock("@/lib/audit-log-store", () => audit)

import {
  getConsentState,
  listConsentStates,
  recordConsent,
  withdrawConsent,
} from "@/lib/privacy-consent-store"

const actor = { userId: 1, name: "Admin", email: "admin@t.test", role: "owner" }
const TENANT_A = 10
const TENANT_B = 20

beforeEach(() => {
  db.reset()
  audit.recordAuditLog.mockClear()
})

describe("recording consent", () => {
  it("records an explicit opt-in and writes audit evidence", async () => {
    const ev = await recordConsent(TENANT_A, { subjectEmail: "Jane@Example.com", purpose: "marketing", method: "explicit_optin" }, actor)
    expect(ev.status).toBe("granted")
    expect(ev.subjectEmail).toBe("jane@example.com")
    const state = await getConsentState(TENANT_A, "jane@example.com", "marketing")
    expect(state?.status).toBe("granted")
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.consent.granted" }),
      undefined,
    )
  })

  it("rejects an invalid subject email", async () => {
    await expect(recordConsent(TENANT_A, { subjectEmail: "nope", purpose: "marketing" }, actor)).rejects.toThrow(/valid subject email/i)
  })
})

describe("withdrawing consent", () => {
  it("appends a withdrawal event that flips the effective state and audits it", async () => {
    await recordConsent(TENANT_A, { subjectEmail: "kip@example.com", purpose: "recruitment" }, actor)
    const wd = await withdrawConsent(TENANT_A, { subjectEmail: "kip@example.com", purpose: "recruitment", notes: "asked to stop" }, actor)
    expect(wd.status).toBe("withdrawn")
    const state = await getConsentState(TENANT_A, "kip@example.com", "recruitment")
    expect(state?.status).toBe("withdrawn")
    expect(state?.eventCount).toBe(2)
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.consent.withdrawn" }),
      undefined,
    )
  })

  it("fails when there is no standing grant to withdraw", async () => {
    await expect(
      withdrawConsent(TENANT_A, { subjectEmail: "ghost@example.com", purpose: "marketing" }, actor),
    ).rejects.toThrow(/no active consent/i)
  })

  it("a fresh grant after a withdrawal re-establishes consent", async () => {
    await recordConsent(TENANT_A, { subjectEmail: "amy@example.com", purpose: "screen_capture" }, actor)
    await withdrawConsent(TENANT_A, { subjectEmail: "amy@example.com", purpose: "screen_capture" }, actor)
    await recordConsent(TENANT_A, { subjectEmail: "amy@example.com", purpose: "screen_capture" }, actor)
    const state = await getConsentState(TENANT_A, "amy@example.com", "screen_capture")
    expect(state?.status).toBe("granted")
    expect(state?.eventCount).toBe(3)
  })
})

describe("cross-tenant isolation", () => {
  it("consent recorded for one tenant is invisible to another", async () => {
    await recordConsent(TENANT_A, { subjectEmail: "shared@example.com", purpose: "marketing" }, actor)
    expect(await getConsentState(TENANT_B, "shared@example.com", "marketing")).toBeNull()
    const bStates = await listConsentStates(TENANT_B)
    expect(bStates).toHaveLength(0)
    const aStates = await listConsentStates(TENANT_A)
    expect(aStates.every((s) => s.subjectEmail !== undefined)).toBe(true)
  })
})
