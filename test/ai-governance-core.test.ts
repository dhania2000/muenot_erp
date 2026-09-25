import { describe, expect, it } from "vitest"
import {
  AI_FEATURES,
  AiError,
  type GlobalAiSettings,
  type TenantAiSettings,
  type UsageSnapshot,
  DEFAULT_GLOBAL_SETTINGS,
  checkBudget,
  defaultTenantSettings,
  monthStart,
  normalizeTenantSettings,
  requiresConfirmation,
  retentionCutoff,
} from "@/lib/ai/governance-core"

/**
 * SPEC 18 — governance tests. Covers Phase 17 (capability classes),
 * Phase 25/26 (settings normalisation), Phase 28 (budget enforcement),
 * Phase 33 (retention) and stable error status mapping.
 */

const global: GlobalAiSettings = DEFAULT_GLOBAL_SETTINGS

describe("requiresConfirmation (Phase 17/18)", () => {
  it("requires confirmation for WRITE / OUTBOUND / SENSITIVE", () => {
    expect(requiresConfirmation("WRITE")).toBe(true)
    expect(requiresConfirmation("OUTBOUND")).toBe(true)
    expect(requiresConfirmation("SENSITIVE")).toBe(true)
  })
  it("never requires confirmation for READ / GENERATE", () => {
    expect(requiresConfirmation("READ")).toBe(false)
    expect(requiresConfirmation("GENERATE")).toBe(false)
  })
})

describe("normalizeTenantSettings (untrusted input clamping)", () => {
  it("defaults AI to disabled and content retained 90 days", () => {
    const s = defaultTenantSettings()
    expect(s.enabled).toBe(false)
    expect(s.retentionDays).toBe(90)
    expect(s.redactionEnabled).toBe(true)
  })

  it("clamps a negative budget to zero and huge budget to the ceiling", () => {
    const s = normalizeTenantSettings({ monthlyBudgetUsd: -5 })
    expect(s.monthlyBudgetUsd).toBe(0)
    const s2 = normalizeTenantSettings({ monthlyBudgetUsd: 9e12 })
    expect(s2.monthlyBudgetUsd).toBe(1_000_000)
  })

  it("clamps the warning threshold into 1..100", () => {
    expect(normalizeTenantSettings({ warningThresholdPct: 0 }).warningThresholdPct).toBe(1)
    expect(normalizeTenantSettings({ warningThresholdPct: 500 }).warningThresholdPct).toBe(100)
  })

  it("rejects malformed model ids in the allow-list", () => {
    const s = normalizeTenantSettings({ allowedModels: ["openai/gpt-5.4", "not a model", 5, "bad;id"] })
    expect(s.allowedModels).toEqual(["openai/gpt-5.4"])
  })

  it("drops a default model that is not within the allow-list", () => {
    const s = normalizeTenantSettings({ allowedModels: ["openai/a"], defaultModel: "openai/b" })
    expect(s.defaultModel).toBeNull()
  })

  it("normalises custom redact fields to safe lower-case tokens", () => {
    const s = normalizeTenantSettings({ customRedactFields: ["Secret Field", "internal_note", "x", "  MRN  "] })
    expect(s.customRedactFields).toContain("internal_note")
    expect(s.customRedactFields).toContain("mrn")
    // "Secret Field" has a space (invalid); "x" is too short.
    expect(s.customRedactFields).not.toContain("secret field")
    expect(s.customRedactFields).not.toContain("x")
  })

  it("preserves all feature flags shape", () => {
    const s = normalizeTenantSettings({ features: { email: false } })
    for (const f of AI_FEATURES) expect(typeof s.features[f]).toBe("boolean")
    expect(s.features.email).toBe(false)
  })
})

describe("checkBudget (Phase 28 pre-flight enforcement)", () => {
  const base = (o: Partial<TenantAiSettings> = {}): TenantAiSettings => ({ ...defaultTenantSettings(), ...o })
  const usage = (o: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
    tenantSpendUsd: 0,
    tenantTokens: 0,
    userSpendUsd: 0,
    userTokens: 0,
    ...o,
  })

  it("blocks when the estimate would exceed the tenant budget", () => {
    const d = checkBudget(usage({ tenantSpendUsd: 49.9 }), base({ monthlyBudgetUsd: 50 }), global, { costUsd: 0.5, tokens: 100 })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe("tenant_budget_exceeded")
  })

  it("blocks when the platform ceiling would be exceeded first", () => {
    const g: GlobalAiSettings = { ...global, maxTenantMonthlyUsd: 10 }
    const d = checkBudget(usage({ tenantSpendUsd: 9.9 }), base({ monthlyBudgetUsd: 1000 }), g, { costUsd: 0.5, tokens: 10 })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe("platform_budget_exceeded")
  })

  it("blocks when the tenant token limit would be exceeded", () => {
    const d = checkBudget(usage({ tenantTokens: 990 }), base({ monthlyBudgetUsd: null, monthlyTokenLimit: 1000 }), global, {
      costUsd: 0,
      tokens: 20,
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe("token_limit_exceeded")
  })

  it("blocks per-user budget", () => {
    const d = checkBudget(usage({ userSpendUsd: 5 }), base({ monthlyBudgetUsd: null, perUserMonthlyBudgetUsd: 5 }), global, {
      costUsd: 0.01,
      tokens: 1,
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe("user_budget_exceeded")
  })

  it("allows and emits a warning past the threshold", () => {
    const d = checkBudget(usage({ tenantSpendUsd: 40 }), base({ monthlyBudgetUsd: 50, warningThresholdPct: 80 }), global, {
      costUsd: 1,
      tokens: 100,
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.warning).toMatch(/%/)
  })

  it("allows with no warning below the threshold", () => {
    const d = checkBudget(usage({ tenantSpendUsd: 1 }), base({ monthlyBudgetUsd: 50 }), global, { costUsd: 0.1, tokens: 10 })
    expect(d.ok && d.warning).toBeNull()
  })

  it("allows freely when no limits are configured", () => {
    const d = checkBudget(usage({ tenantSpendUsd: 1e6 }), base({ monthlyBudgetUsd: null, monthlyTokenLimit: null }), global, {
      costUsd: 999,
      tokens: 1e9,
    })
    expect(d.ok).toBe(true)
  })
})

describe("retention (Phase 33)", () => {
  const now = new Date("2026-06-15T00:00:00Z")
  it("returns now (delete everything) when retention is zero", () => {
    expect(retentionCutoff(0, now)!.getTime()).toBe(now.getTime())
  })
  it("returns a cutoff N days in the past", () => {
    const cut = retentionCutoff(30, now)!
    expect(cut.toISOString()).toBe("2026-05-16T00:00:00.000Z")
  })
  it("monthStart returns the first of the UTC month", () => {
    expect(monthStart(now).toISOString()).toBe("2026-06-01T00:00:00.000Z")
  })
})

describe("AiError status mapping", () => {
  it("maps budget errors to 402 and unknown codes to 403", () => {
    expect(new AiError("tenant_budget_exceeded", "x").status).toBe(402)
    expect(new AiError("unauthenticated", "x").status).toBe(401)
    expect(new AiError("fallback_requires_confirmation", "x").status).toBe(409)
    expect(new AiError("permission_denied", "x").status).toBe(403)
    expect(new AiError("rate_limited", "x").status).toBe(429)
  })
})
