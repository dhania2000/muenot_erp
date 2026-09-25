/**
 * SPEC 18 — AI model registry (pure). No DB, no network: every decision about
 * which model a request may use lives here so it is exhaustively testable.
 *
 * Models are routed through the Vercel AI Gateway using `provider/model` IDs.
 * Pricing is stored per million tokens and versioned so historic cost records
 * stay reproducible after a price change.
 */

export type ModelTier = "economy" | "standard" | "advanced"
export type ModelAvailability = "available" | "preview" | "unavailable"

export type AiModel = {
  /** Gateway model ID, e.g. `openai/gpt-5.4-mini`. Primary key. */
  id: string
  provider: string
  displayName: string
  description: string
  enabled: boolean
  availability: ModelAvailability
  tier: ModelTier
  speed: "fast" | "balanced" | "thorough"
  supportsTools: boolean
  supportsStructuredOutput: boolean
  supportsReasoning: boolean
  contextWindow: number
  maxOutputTokens: number
  inputPricePerMTok: number
  outputPricePerMTok: number
  cachedInputPricePerMTok: number | null
  pricingVersion: number
  recommendedFor: string[]
  deprecated: boolean
  replacementModelId: string | null
  /** Plan keys allowed to use this model; null = every plan. */
  allowedPlans: string[] | null
  /** Tenant IDs explicitly allowed (beta access); null = no allow-list. */
  allowedTenantIds: number[] | null
  /** Platform-wide monthly token ceiling for this model; null = no cap. */
  monthlyTokenCap: number | null
}

export const SEED_MODELS: AiModel[] = [
  {
    id: "openai/gpt-5.4-mini",
    provider: "openai",
    displayName: "GPT-5.4 mini",
    description: "Fast, low-cost default for everyday ERP questions and drafting.",
    enabled: true,
    availability: "available",
    tier: "standard",
    speed: "fast",
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsReasoning: true,
    contextWindow: 400_000,
    maxOutputTokens: 4_000,
    inputPricePerMTok: 0.75,
    outputPricePerMTok: 4.5,
    cachedInputPricePerMTok: 0.075,
    pricingVersion: 1,
    recommendedFor: ["chat", "erp_qa", "writing", "email", "whatsapp"],
    deprecated: false,
    replacementModelId: null,
    allowedPlans: null,
    allowedTenantIds: null,
    monthlyTokenCap: null,
  },
  {
    id: "openai/gpt-5.4-nano",
    provider: "openai",
    displayName: "GPT-5.4 nano",
    description: "Cheapest option for short rewrites, summaries and classification.",
    enabled: true,
    availability: "available",
    tier: "economy",
    speed: "fast",
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsReasoning: true,
    contextWindow: 400_000,
    maxOutputTokens: 2_000,
    inputPricePerMTok: 0.2,
    outputPricePerMTok: 1.25,
    cachedInputPricePerMTok: 0.02,
    pricingVersion: 1,
    recommendedFor: ["writing", "content"],
    deprecated: false,
    replacementModelId: null,
    allowedPlans: null,
    allowedTenantIds: null,
    monthlyTokenCap: null,
  },
  {
    id: "openai/gpt-5.4",
    provider: "openai",
    displayName: "GPT-5.4",
    description: "Balanced reasoning for reports, analysis and multi-step questions.",
    enabled: true,
    availability: "available",
    tier: "advanced",
    speed: "balanced",
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsReasoning: true,
    contextWindow: 1_050_000,
    maxOutputTokens: 8_000,
    inputPricePerMTok: 2.5,
    outputPricePerMTok: 15,
    cachedInputPricePerMTok: 0.25,
    pricingVersion: 1,
    recommendedFor: ["reports", "erp_qa", "marketing"],
    deprecated: false,
    replacementModelId: null,
    allowedPlans: null,
    allowedTenantIds: null,
    monthlyTokenCap: null,
  },
  {
    id: "openai/gpt-5.5",
    provider: "openai",
    displayName: "GPT-5.5",
    description: "Most capable model for complex analysis. Highest cost.",
    enabled: true,
    availability: "available",
    tier: "advanced",
    speed: "thorough",
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsReasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 8_000,
    inputPricePerMTok: 5,
    outputPricePerMTok: 30,
    cachedInputPricePerMTok: 0.5,
    pricingVersion: 1,
    recommendedFor: ["reports"],
    deprecated: false,
    replacementModelId: null,
    allowedPlans: null,
    allowedTenantIds: null,
    monthlyTokenCap: null,
  },
]

export const DEFAULT_MODEL_ID = "openai/gpt-5.4-mini"
export const DEFAULT_FALLBACK_MODEL_ID = "openai/gpt-5.4-nano"

export type ModelAccessContext = {
  tenantId: number
  planKey: string | null
  /** Tenant's own allow-list; null = every model the platform permits. */
  tenantAllowedModels: string[] | null
  /** Whether the tenant's plan unlocks the "advanced" tier. */
  advancedEntitled: boolean
  /** Request needs tool calling (ERP data questions, actions). */
  needsTools: boolean
}

export type AccessDecision = { allowed: true } | { allowed: false; reason: string }

/** Whether one model may serve one request. Fail-closed: first failing rule wins. */
export function checkModelAccess(model: AiModel, ctx: ModelAccessContext): AccessDecision {
  if (!model.enabled) return { allowed: false, reason: "Model is disabled by the platform" }
  if (model.availability === "unavailable") return { allowed: false, reason: "Model is currently unavailable" }
  if (model.deprecated && !model.replacementModelId) {
    // Deprecated with no replacement stays usable until the platform disables it.
  }
  const betaListed = model.allowedTenantIds?.includes(ctx.tenantId) ?? false
  if (model.allowedPlans && !betaListed) {
    if (!ctx.planKey || !model.allowedPlans.includes(ctx.planKey)) {
      return { allowed: false, reason: "Model is not included in your plan" }
    }
  }
  if (model.tier === "advanced" && !ctx.advancedEntitled && !betaListed) {
    return { allowed: false, reason: "Advanced models require an upgraded plan" }
  }
  if (ctx.tenantAllowedModels && !ctx.tenantAllowedModels.includes(model.id)) {
    return { allowed: false, reason: "Model is not enabled for your organisation" }
  }
  if (ctx.needsTools && !model.supportsTools) {
    return { allowed: false, reason: "Model does not support ERP data tools" }
  }
  return { allowed: true }
}

export function availableModels(models: AiModel[], ctx: ModelAccessContext): AiModel[] {
  return models.filter((m) => checkModelAccess(m, ctx).allowed)
}

export type ModelSelection =
  | { ok: true; model: AiModel; fallbackFrom: string | null }
  | { ok: false; code: "model_not_allowed" | "no_model_available" | "fallback_requires_confirmation"; message: string; fallbackModelId?: string }

export type SelectionPolicy = {
  tenantDefaultModel: string | null
  globalDefaultModel: string
  globalFallbackModel: string
  allowFallback: boolean
  fallbackRequiresConfirmation: boolean
}

/** Blended price used to compare model cost (1:3 input:output mix). */
export function blendedPrice(m: AiModel): number {
  return (m.inputPricePerMTok + 3 * m.outputPricePerMTok) / 4
}

/**
 * Pick the model for a request. An explicit user choice is honoured only if
 * access passes; otherwise falls back through tenant default -> global default
 * -> global fallback. A fallback to a MORE expensive model requires explicit
 * acceptance when the tenant policy demands it (never silently cost more).
 */
export function selectModel(
  requestedId: string | null,
  models: AiModel[],
  ctx: ModelAccessContext,
  policy: SelectionPolicy,
  acceptFallback = false,
): ModelSelection {
  const byId = new Map(models.map((m) => [m.id, m]))
  const usable = (id: string | null | undefined) => {
    if (!id) return null
    const m = byId.get(id)
    return m && checkModelAccess(m, ctx).allowed ? m : null
  }

  const requested = requestedId ? byId.get(requestedId) ?? null : null
  if (requestedId) {
    const direct = usable(requestedId)
    if (direct) return { ok: true, model: direct, fallbackFrom: null }
    // Deprecated model with a usable replacement: transparent upgrade path.
    if (requested?.replacementModelId) {
      const repl = usable(requested.replacementModelId)
      if (repl) return { ok: true, model: repl, fallbackFrom: requestedId }
    }
    if (!policy.allowFallback) {
      const reason = requested ? (checkModelAccess(requested, ctx) as { reason: string }).reason : "Unknown model"
      return { ok: false, code: "model_not_allowed", message: reason }
    }
  }

  const chain = [policy.tenantDefaultModel, policy.globalDefaultModel, policy.globalFallbackModel]
  for (const id of chain) {
    const m = usable(id)
    if (!m) continue
    if (requestedId && requested && policy.fallbackRequiresConfirmation && !acceptFallback) {
      if (blendedPrice(m) > blendedPrice(requested)) {
        return {
          ok: false,
          code: "fallback_requires_confirmation",
          message: `${requested.displayName} is unavailable. ${m.displayName} costs more — confirm to continue.`,
          fallbackModelId: m.id,
        }
      }
    }
    return { ok: true, model: m, fallbackFrom: requestedId && requestedId !== m.id ? requestedId : null }
  }
  return { ok: false, code: "no_model_available", message: "No AI model is available for your organisation" }
}

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

/** Cost in USD, rounded to 6 decimals. Cached input billed at the cached rate when known. */
export function computeCostUsd(usage: TokenUsage, model: Pick<AiModel, "inputPricePerMTok" | "outputPricePerMTok" | "cachedInputPricePerMTok">): number {
  const cached = Math.max(0, Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens))
  const uncached = Math.max(0, usage.inputTokens - cached)
  const cachedRate = model.cachedInputPricePerMTok ?? model.inputPricePerMTok
  const cost =
    (uncached * model.inputPricePerMTok + cached * cachedRate + Math.max(0, usage.outputTokens) * model.outputPricePerMTok) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}

/** Pre-flight worst-case estimate so budgets are checked BEFORE the call. */
export function estimateMaxCostUsd(promptChars: number, model: AiModel): number {
  const inputTokens = Math.ceil(promptChars / 3.5)
  return computeCostUsd({ inputTokens, outputTokens: model.maxOutputTokens }, model)
}
