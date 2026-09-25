import { describe, expect, it } from "vitest"
import {
  REDACTED,
  assertSandboxIsolation,
  assertSanitized,
  baselineHash,
  changedKeys,
  diffConfig,
  evaluatePromotion,
  isApprovalStale,
  isEnterpriseTenant,
  isSandboxIsolated,
  isSecretKey,
  redactValue,
  sanitizeConfigMap,
  toChangeStatus,
  toDeployStatus,
} from "@/lib/sandbox/model"

/**
 * Pure-core tests for the sandbox / change-approval domain (lib/sandbox/model.ts).
 * These lock the three invariants the spec calls out — production isolation,
 * secret redaction, and the promotion gate (denied promotion, stale approval) —
 * without a DB or server context.
 */

describe("enterprise gating", () => {
  it("admits only enterprise tenants, case-insensitively", () => {
    expect(isEnterpriseTenant("ENTERPRISE")).toBe(true)
    expect(isEnterpriseTenant("enterprise")).toBe(true)
    expect(isEnterpriseTenant("Enterprise")).toBe(true)
    expect(isEnterpriseTenant("SME")).toBe(false)
    expect(isEnterpriseTenant("")).toBe(false)
    expect(isEnterpriseTenant(null)).toBe(false)
    expect(isEnterpriseTenant(undefined)).toBe(false)
  })
})

describe("status coercion", () => {
  it("falls back to safe defaults for unknown values", () => {
    expect(toChangeStatus("approved")).toBe("approved")
    expect(toChangeStatus("garbage")).toBe("draft")
    expect(toChangeStatus(null)).toBe("draft")
    expect(toDeployStatus("deployed")).toBe("deployed")
    expect(toDeployStatus("garbage")).toBe("not_deployed")
  })
})

describe("secret detection & redaction", () => {
  it("flags secret-bearing keys via heuristic and passes plain keys", () => {
    for (const k of ["api_key", "API_KEY", "smtp_password", "webhook_secret", "client_secret", "access_key", "private_key"]) {
      expect(isSecretKey(k)).toBe(true)
    }
    for (const k of ["company.name", "feature.enabled", "theme", "locale"]) {
      expect(isSecretKey(k)).toBe(false)
    }
  })

  it("redactValue masks secret values but preserves null/empty", () => {
    expect(redactValue("api_key", "sk-live-123")).toBe(REDACTED)
    expect(redactValue("api_key", null)).toBeNull()
    expect(redactValue("api_key", "")).toBe("")
    expect(redactValue("theme", "dark")).toBe("dark")
  })

  it("sanitizeConfigMap masks every secret and preserves non-secrets", () => {
    const out = sanitizeConfigMap({ "smtp_password": "hunter2", "company.name": "Acme", "api_key": "", "theme": "dark" })
    expect(out["smtp_password"]).toBe(REDACTED)
    expect(out["company.name"]).toBe("Acme")
    expect(out["api_key"]).toBe("") // empty secret stays empty, not masked
    expect(out["theme"]).toBe("dark")
  })

  it("assertSanitized passes clean maps and throws on a leaked plaintext secret", () => {
    expect(assertSanitized(sanitizeConfigMap({ "api_key": "sk-live", "theme": "dark" }))).toBe(true)
    expect(() => assertSanitized({ "api_key": "sk-live-leaked" })).toThrow(/leaked/i)
    // A masked secret and an empty secret are both acceptable.
    expect(assertSanitized({ "api_key": REDACTED, "webhook_secret": "" })).toBe(true)
  })
})

describe("config diff", () => {
  it("computes ordered add/update/remove ops", () => {
    const diff = diffConfig(
      { keep: "1", change: "old", drop: "x" },
      { keep: "1", change: "new", add: "y" },
    )
    // keep is unchanged and omitted; result is sorted by key.
    expect(diff.map((d) => [d.key, d.op])).toEqual([
      ["add", "add"],
      ["change", "update"],
      ["drop", "remove"],
    ])
  })

  it("redacts secret values in the diff but still flags them as secret", () => {
    const diff = diffConfig({ "api_key": "old-secret" }, { "api_key": "new-secret" })
    expect(diff).toHaveLength(1)
    expect(diff[0]).toMatchObject({ key: "api_key", op: "update", before: REDACTED, after: REDACTED, secret: true })
  })

  it("treats an empty-string base as an add, and empty-string proposed as a remove", () => {
    expect(diffConfig({ k: "" }, { k: "v" })[0].op).toBe("add")
    expect(diffConfig({ k: "v" }, { k: "" })[0].op).toBe("remove")
  })

  it("changedKeys lists only the keys that differ", () => {
    expect(changedKeys({ a: "1", b: "2" }, { a: "1", b: "9", c: "3" }).sort()).toEqual(["b", "c"])
  })
})

describe("baseline hashing & staleness", () => {
  it("is deterministic and order-independent over the tracked keys", () => {
    const a = baselineHash({ x: "1", y: "2", z: "9" }, ["x", "y"])
    const b = baselineHash({ y: "2", x: "1", ignored: "diff" }, ["y", "x"])
    expect(a).toBe(b)
  })

  it("changes when a tracked production value drifts", () => {
    const before = baselineHash({ x: "1" }, ["x"])
    const after = baselineHash({ x: "2" }, ["x"])
    expect(before).not.toBe(after)
  })

  it("marks approvals stale when hash is missing or drifted", () => {
    expect(isApprovalStale(null, "abc")).toBe(true)
    expect(isApprovalStale("abc", "def")).toBe(true)
    expect(isApprovalStale("abc", "abc")).toBe(false)
  })
})

describe("production isolation", () => {
  const prod = { schema: "prod_db", connectionRef: "conn-prod" }

  it("passes when the schema or the connection ref differs", () => {
    expect(assertSandboxIsolation(prod, { schema: "sbx_db", connectionRef: "conn-prod" })).toBe(true)
    expect(assertSandboxIsolation(prod, { schema: "prod_db", connectionRef: "conn-sbx" })).toBe(true)
    expect(isSandboxIsolated(prod, { schema: "sbx_db", connectionRef: "conn-sbx" })).toBe(true)
  })

  it("fails closed when the sandbox shares the production connection set", () => {
    expect(() => assertSandboxIsolation(prod, { schema: "prod_db", connectionRef: "conn-prod" })).toThrow(/isolation/i)
    expect(isSandboxIsolated(prod, { schema: "prod_db", connectionRef: "conn-prod" })).toBe(false)
    // Both null on each side collapses to identical → not isolated.
    expect(isSandboxIsolated({ schema: null, connectionRef: null }, { schema: null, connectionRef: null })).toBe(false)
  })
})

describe("promotion gate", () => {
  const fresh = {
    changeStatus: "approved" as const,
    approvalStatus: "approved" as const,
    approvedBaselineHash: "h1",
    currentProductionHash: "h1",
    isolated: true,
  }

  it("allows an approved, isolated, fresh change", () => {
    expect(evaluatePromotion(fresh)).toEqual({ ok: true })
    expect(evaluatePromotion({ ...fresh, approvalStatus: "auto_approved" })).toEqual({ ok: true })
  })

  it("denies promotion of a change that is not approved", () => {
    const d = evaluatePromotion({ ...fresh, changeStatus: "pending_approval", approvalStatus: "pending" })
    expect(d).toMatchObject({ ok: false, code: "NOT_APPROVED" })
  })

  it("denies promotion when the approval is stale (production drifted)", () => {
    const d = evaluatePromotion({ ...fresh, currentProductionHash: "h2" })
    expect(d).toMatchObject({ ok: false, code: "STALE_APPROVAL" })
  })

  it("denies promotion when the sandbox is not isolated from production", () => {
    const d = evaluatePromotion({ ...fresh, isolated: false })
    expect(d).toMatchObject({ ok: false, code: "NOT_ISOLATED" })
  })

  it("denies re-promotion of an already-promoted change", () => {
    const d = evaluatePromotion({ ...fresh, changeStatus: "promoted" })
    expect(d).toMatchObject({ ok: false, code: "ALREADY_PROMOTED" })
  })

  it("checks already-promoted and isolation before approval/staleness", () => {
    // A promoted change that also drifted still reports ALREADY_PROMOTED first.
    expect(evaluatePromotion({ ...fresh, changeStatus: "promoted", currentProductionHash: "h9" })).toMatchObject({
      code: "ALREADY_PROMOTED",
    })
  })
})
