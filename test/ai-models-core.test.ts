import { describe, expect, it } from "vitest"
import {
  type AiModel,
  type ModelAccessContext,
  type SelectionPolicy,
  DEFAULT_FALLBACK_MODEL_ID,
  DEFAULT_MODEL_ID,
  SEED_MODELS,
  availableModels,
  blendedPrice,
  checkModelAccess,
  computeCostUsd,
  estimateMaxCostUsd,
  selectModel,
} from "@/lib/ai/models-core"

/**
 * SPEC 18 — AI model registry / governance tests.
 * Covers Phase 4/5 (model selector + governance), Phase 37 (fallback),
 * Phase 28/29 (cost) and the security rule that a tenant never silently gets
 * unrestricted access to expensive models.
 */

function model(overrides: Partial<AiModel> = {}): AiModel {
  return {
    id: overrides.id ?? "openai/test",
    provider: overrides.provider ?? "openai",
    displayName: overrides.displayName ?? "Test",
    description: overrides.description ?? "",
    enabled: overrides.enabled ?? true,
    availability: overrides.availability ?? "available",
    tier: overrides.tier ?? "standard",
    speed: overrides.speed ?? "balanced",
    supportsTools: overrides.supportsTools ?? true,
    supportsStructuredOutput: overrides.supportsStructuredOutput ?? true,
    supportsReasoning: overrides.supportsReasoning ?? true,
    contextWindow: overrides.contextWindow ?? 100_000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4_000,
    inputPricePerMTok: overrides.inputPricePerMTok ?? 1,
    outputPricePerMTok: overrides.outputPricePerMTok ?? 3,
    cachedInputPricePerMTok: overrides.cachedInputPricePerMTok ?? 0.1,
    pricingVersion: overrides.pricingVersion ?? 1,
    recommendedFor: overrides.recommendedFor ?? [],
    deprecated: overrides.deprecated ?? false,
    replacementModelId: overrides.replacementModelId ?? null,
    allowedPlans: overrides.allowedPlans ?? null,
    allowedTenantIds: overrides.allowedTenantIds ?? null,
    monthlyTokenCap: overrides.monthlyTokenCap ?? null,
  }
}

function ctx(overrides: Partial<ModelAccessContext> = {}): ModelAccessContext {
  return {
    tenantId: overrides.tenantId ?? 1,
    planKey: overrides.planKey ?? "pro",
    tenantAllowedModels: overrides.tenantAllowedModels ?? null,
    advancedEntitled: overrides.advancedEntitled ?? true,
    needsTools: overrides.needsTools ?? false,
  }
}

function policy(overrides: Partial<SelectionPolicy> = {}): SelectionPolicy {
  return {
    tenantDefaultModel: overrides.tenantDefaultModel ?? null,
    globalDefaultModel: overrides.globalDefaultModel ?? DEFAULT_MODEL_ID,
    globalFallbackModel: overrides.globalFallbackModel ?? DEFAULT_FALLBACK_MODEL_ID,
    allowFallback: overrides.allowFallback ?? true,
    fallbackRequiresConfirmation: overrides.fallbackRequiresConfirmation ?? true,
  }
}

describe("checkModelAccess (fail-closed governance)", () => {
  it("denies disabled models", () => {
    expect(checkModelAccess(model({ enabled: false }), ctx()).allowed).toBe(false)
  })

  it("denies unavailable models", () => {
    expect(checkModelAccess(model({ availability: "unavailable" }), ctx()).allowed).toBe(false)
  })

  it("denies a model not included in the tenant's plan", () => {
    const d = checkModelAccess(model({ allowedPlans: ["enterprise"] }), ctx({ planKey: "pro" }))
    expect(d.allowed).toBe(false)
  })

  it("allows a plan-restricted model when the plan matches", () => {
    expect(checkModelAccess(model({ allowedPlans: ["pro"] }), ctx({ planKey: "pro" })).allowed).toBe(true)
  })

  it("allows a beta-listed tenant to bypass the plan allow-list", () => {
    const m = model({ allowedPlans: ["enterprise"], allowedTenantIds: [7] })
    expect(checkModelAccess(m, ctx({ tenantId: 7, planKey: "free" })).allowed).toBe(true)
  })

  it("blocks advanced tier without entitlement", () => {
    const d = checkModelAccess(model({ tier: "advanced" }), ctx({ advancedEntitled: false }))
    expect(d.allowed).toBe(false)
  })

  it("allows advanced tier for beta-listed tenant even without entitlement", () => {
    const m = model({ tier: "advanced", allowedTenantIds: [3] })
    expect(checkModelAccess(m, ctx({ tenantId: 3, advancedEntitled: false })).allowed).toBe(true)
  })

  it("enforces the tenant's own allow-list", () => {
    const d = checkModelAccess(model({ id: "openai/x" }), ctx({ tenantAllowedModels: ["openai/y"] }))
    expect(d.allowed).toBe(false)
  })

  it("requires tool support when the request needs tools", () => {
    const d = checkModelAccess(model({ supportsTools: false }), ctx({ needsTools: true }))
    expect(d.allowed).toBe(false)
  })
})

describe("availableModels", () => {
  it("returns only models the context may use", () => {
    const models = [model({ id: "a" }), model({ id: "b", enabled: false }), model({ id: "c", tier: "advanced" })]
    const list = availableModels(models, ctx({ advancedEntitled: false }))
    expect(list.map((m) => m.id)).toEqual(["a"])
  })
})

describe("selectModel (Phase 37 fallback)", () => {
  const models = [
    model({ id: "cheap", tier: "economy", inputPricePerMTok: 0.2, outputPricePerMTok: 1 }),
    model({ id: "mid", tier: "standard", inputPricePerMTok: 1, outputPricePerMTok: 3 }),
    model({ id: "pricey", tier: "advanced", inputPricePerMTok: 5, outputPricePerMTok: 30 }),
  ]

  it("honours an explicit allowed choice", () => {
    const r = selectModel("mid", models, ctx(), policy())
    expect(r.ok && r.model.id).toBe("mid")
  })

  it("rejects an unauthorized explicit choice when fallback is off", () => {
    const r = selectModel("pricey", models, ctx({ advancedEntitled: false }), policy({ allowFallback: false }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("model_not_allowed")
  })

  it("transparently upgrades a retired model to its replacement", () => {
    const withDep = [...models, model({ id: "old", enabled: false, deprecated: true, replacementModelId: "mid" })]
    const r = selectModel("old", withDep, ctx(), policy({ allowFallback: false }))
    expect(r.ok && r.model.id).toBe("mid")
    expect(r.ok && r.fallbackFrom).toBe("old")
  })

  it("requires confirmation before falling back to a MORE expensive model", () => {
    // Requested a model that is not allowed; only remaining usable is pricier.
    const r = selectModel(
      "cheap",
      models,
      ctx({ tenantAllowedModels: ["pricey"] }),
      policy({ tenantDefaultModel: "pricey", globalDefaultModel: "pricey", globalFallbackModel: "pricey" }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("fallback_requires_confirmation")
      expect(r.fallbackModelId).toBe("pricey")
    }
  })

  it("accepts the pricier fallback once confirmed", () => {
    const r = selectModel(
      "cheap",
      models,
      ctx({ tenantAllowedModels: ["pricey"] }),
      policy({ tenantDefaultModel: "pricey", globalDefaultModel: "pricey", globalFallbackModel: "pricey" }),
      true,
    )
    expect(r.ok && r.model.id).toBe("pricey")
  })

  it("does not require confirmation when the fallback is cheaper or equal", () => {
    const r = selectModel(
      "pricey",
      models,
      ctx({ tenantAllowedModels: ["cheap"] }),
      policy({ tenantDefaultModel: "cheap", globalDefaultModel: "cheap", globalFallbackModel: "cheap" }),
    )
    expect(r.ok && r.model.id).toBe("cheap")
  })

  it("returns no_model_available when nothing is usable", () => {
    const r = selectModel(null, models, ctx({ tenantAllowedModels: ["nonexistent"] }), policy())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("no_model_available")
  })
})

describe("cost calculation (Phase 28/29)", () => {
  it("computes blended cost with uncached input", () => {
    const m = model({ inputPricePerMTok: 1, outputPricePerMTok: 3, cachedInputPricePerMTok: 0.1 })
    // 1M input + 1M output = 1 + 3 = 4 USD
    expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, m)).toBeCloseTo(4, 6)
  })

  it("bills cached input at the cached rate", () => {
    const m = model({ inputPricePerMTok: 1, outputPricePerMTok: 0, cachedInputPricePerMTok: 0.1 })
    // 1M cached input only -> 0.1 USD
    expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, m)).toBeCloseTo(0.1, 6)
  })

  it("clamps cached tokens to the input total and ignores negatives", () => {
    const m = model({ inputPricePerMTok: 1, outputPricePerMTok: 1, cachedInputPricePerMTok: 0 })
    const c = computeCostUsd({ inputTokens: 100, outputTokens: -50, cachedInputTokens: 999 }, m)
    expect(c).toBe(0)
  })

  it("estimateMaxCostUsd assumes full output for a pre-flight budget check", () => {
    const m = model({ maxOutputTokens: 1_000_000, inputPricePerMTok: 0, outputPricePerMTok: 3 })
    expect(estimateMaxCostUsd(0, m)).toBeCloseTo(3, 6)
  })

  it("blendedPrice weights output 3:1 over input", () => {
    expect(blendedPrice(model({ inputPricePerMTok: 4, outputPricePerMTok: 4 }))).toBe(4)
    expect(blendedPrice(model({ inputPricePerMTok: 0, outputPricePerMTok: 4 }))).toBe(3)
  })
})

describe("SEED_MODELS integrity", () => {
  it("has unique ids and valid gateway id format", () => {
    const ids = SEED_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9.\-]+$/i)
  })

  it("ships the configured default and fallback models", () => {
    const ids = new Set(SEED_MODELS.map((m) => m.id))
    expect(ids.has(DEFAULT_MODEL_ID)).toBe(true)
    expect(ids.has(DEFAULT_FALLBACK_MODEL_ID)).toBe(true)
  })
})
