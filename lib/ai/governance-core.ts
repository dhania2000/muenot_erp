/**
 * SPEC 18 — AI governance (pure): tenant/global settings, capability
 * classification, budget enforcement, retention and stable error codes.
 */

export const AI_FEATURES = [
  "chat",
  "erp_qa",
  "content",
  "writing",
  "marketing",
  "email",
  "whatsapp",
  "reports",
  "kb",
  "actions",
] as const
export type AiFeature = (typeof AI_FEATURES)[number]

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  chat: "Assistant chat",
  erp_qa: "ERP data questions",
  content: "Content generation",
  writing: "Writing assistance",
  marketing: "Marketing copy",
  email: "Email drafting",
  whatsapp: "WhatsApp drafting",
  reports: "Report summaries",
  kb: "Knowledge base answers",
  actions: "Actions (with confirmation)",
}

/**
 * Capability classes. READ/GENERATE run immediately. WRITE, OUTBOUND and
 * SENSITIVE never execute from a model response — they create a proposal the
 * user must explicitly confirm.
 */
export type CapabilityClass = "READ" | "GENERATE" | "WRITE" | "OUTBOUND" | "SENSITIVE"

export function requiresConfirmation(cls: CapabilityClass): boolean {
  return cls === "WRITE" || cls === "OUTBOUND" || cls === "SENSITIVE"
}

export type GlobalAiSettings = {
  enabled: boolean
  /** Emergency kill switch — blocks every tenant immediately. */
  emergencyDisabled: boolean
  defaultModel: string
  fallbackModel: string
  /** Hard platform ceiling per tenant per month; null = none. */
  maxTenantMonthlyUsd: number | null
}

export type TenantAiSettings = {
  enabled: boolean
  features: Record<AiFeature, boolean>
  allowedModels: string[] | null
  defaultModel: string | null
  monthlyBudgetUsd: number | null
  monthlyTokenLimit: number | null
  perUserMonthlyTokenLimit: number | null
  perUserMonthlyBudgetUsd: number | null
  /** 0-100. Emit a warning once spend crosses this share of the budget. */
  warningThresholdPct: number
  /** Days to keep conversations/prompts. 0 = do not persist content. */
  retentionDays: number
  historyEnabled: boolean
  redactionEnabled: boolean
  /** Extra field names (lower-case) to always redact. */
  customRedactFields: string[]
  citationsRequired: boolean
  allowFallback: boolean
  fallbackRequiresConfirmation: boolean
  allowSensitiveData: boolean
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalAiSettings = {
  enabled: true,
  emergencyDisabled: false,
  defaultModel: "openai/gpt-5.4-mini",
  fallbackModel: "openai/gpt-5.4-nano",
  maxTenantMonthlyUsd: null,
}

export function defaultTenantSettings(): TenantAiSettings {
  const features = Object.fromEntries(AI_FEATURES.map((f) => [f, true])) as Record<AiFeature, boolean>
  return {
    enabled: false,
    features,
    allowedModels: null,
    defaultModel: null,
    monthlyBudgetUsd: 50,
    monthlyTokenLimit: null,
    perUserMonthlyTokenLimit: null,
    perUserMonthlyBudgetUsd: null,
    warningThresholdPct: 80,
    retentionDays: 90,
    historyEnabled: true,
    redactionEnabled: true,
    customRedactFields: [],
    citationsRequired: true,
    allowFallback: true,
    fallbackRequiresConfirmation: true,
    allowSensitiveData: false,
  }
}

const num = (v: unknown, min: number, max: number): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/** Merge untrusted input over current settings, clamping every field. */
export function normalizeTenantSettings(input: unknown, base: TenantAiSettings = defaultTenantSettings()): TenantAiSettings {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, any>
  const out: TenantAiSettings = { ...base, features: { ...base.features } }
  const bool = (k: keyof TenantAiSettings) => {
    if (typeof src[k] === "boolean") (out as any)[k] = src[k]
  }
  ;(["enabled", "historyEnabled", "redactionEnabled", "citationsRequired", "allowFallback", "fallbackRequiresConfirmation", "allowSensitiveData"] as const).forEach(bool)
  if (src.features && typeof src.features === "object") {
    for (const f of AI_FEATURES) if (typeof src.features[f] === "boolean") out.features[f] = src.features[f]
  }
  if ("allowedModels" in src) {
    out.allowedModels = Array.isArray(src.allowedModels)
      ? [...new Set(src.allowedModels.filter((m: unknown) => typeof m === "string" && /^[a-z0-9-]+\/[a-z0-9.\-]+$/i.test(m)))] as string[]
      : null
  }
  if ("defaultModel" in src) out.defaultModel = typeof src.defaultModel === "string" && src.defaultModel ? src.defaultModel : null
  if ("monthlyBudgetUsd" in src) out.monthlyBudgetUsd = num(src.monthlyBudgetUsd, 0, 1_000_000)
  if ("monthlyTokenLimit" in src) out.monthlyTokenLimit = num(src.monthlyTokenLimit, 0, 1e12)
  if ("perUserMonthlyTokenLimit" in src) out.perUserMonthlyTokenLimit = num(src.perUserMonthlyTokenLimit, 0, 1e12)
  if ("perUserMonthlyBudgetUsd" in src) out.perUserMonthlyBudgetUsd = num(src.perUserMonthlyBudgetUsd, 0, 1_000_000)
  if ("warningThresholdPct" in src) out.warningThresholdPct = num(src.warningThresholdPct, 1, 100) ?? base.warningThresholdPct
  if ("retentionDays" in src) out.retentionDays = Math.round(num(src.retentionDays, 0, 3650) ?? base.retentionDays)
  if (Array.isArray(src.customRedactFields)) {
    out.customRedactFields = src.customRedactFields
      .filter((f: unknown) => typeof f === "string")
      .map((f: string) => f.trim().toLowerCase())
      .filter((f: string) => /^[a-z0-9_]{2,64}$/.test(f))
      .slice(0, 50)
  }
  if (out.defaultModel && out.allowedModels && !out.allowedModels.includes(out.defaultModel)) out.defaultModel = null
  return out
}

export type UsageSnapshot = {
  tenantSpendUsd: number
  tenantTokens: number
  userSpendUsd: number
  userTokens: number
}

export type BudgetDecision =
  | { ok: true; warning: string | null }
  | { ok: false; code: "tenant_budget_exceeded" | "user_budget_exceeded" | "token_limit_exceeded" | "platform_budget_exceeded"; message: string }

/**
 * Enforced BEFORE the provider call using a worst-case estimate, so a single
 * request can never push spend past a hard limit by more than zero.
 */
export function checkBudget(
  usage: UsageSnapshot,
  settings: TenantAiSettings,
  global: GlobalAiSettings,
  estimate: { costUsd: number; tokens: number },
): BudgetDecision {
  const tSpend = usage.tenantSpendUsd + estimate.costUsd
  if (global.maxTenantMonthlyUsd != null && tSpend > global.maxTenantMonthlyUsd) {
    return { ok: false, code: "platform_budget_exceeded", message: "Your organisation has reached the platform AI limit for this month" }
  }
  if (settings.monthlyBudgetUsd != null && tSpend > settings.monthlyBudgetUsd) {
    return { ok: false, code: "tenant_budget_exceeded", message: "Your organisation's monthly AI budget has been reached" }
  }
  if (settings.monthlyTokenLimit != null && usage.tenantTokens + estimate.tokens > settings.monthlyTokenLimit) {
    return { ok: false, code: "token_limit_exceeded", message: "Your organisation's monthly AI token limit has been reached" }
  }
  if (settings.perUserMonthlyBudgetUsd != null && usage.userSpendUsd + estimate.costUsd > settings.perUserMonthlyBudgetUsd) {
    return { ok: false, code: "user_budget_exceeded", message: "You have reached your personal monthly AI budget" }
  }
  if (settings.perUserMonthlyTokenLimit != null && usage.userTokens + estimate.tokens > settings.perUserMonthlyTokenLimit) {
    return { ok: false, code: "user_budget_exceeded", message: "You have reached your personal monthly AI token limit" }
  }
  let warning: string | null = null
  if (settings.monthlyBudgetUsd != null && settings.monthlyBudgetUsd > 0) {
    const pct = (tSpend / settings.monthlyBudgetUsd) * 100
    if (pct >= settings.warningThresholdPct) warning = `AI spend is at ${Math.floor(pct)}% of this month's budget`
  }
  return { ok: true, warning }
}

export function retentionCutoff(retentionDays: number, now: Date = new Date()): Date | null {
  if (retentionDays <= 0) return now
  return new Date(now.getTime() - retentionDays * 86_400_000)
}

export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export type AiErrorCode =
  | "unauthenticated"
  | "ai_disabled"
  | "ai_emergency_disabled"
  | "module_not_entitled"
  | "feature_disabled"
  | "permission_denied"
  | "model_not_allowed"
  | "no_model_available"
  | "fallback_requires_confirmation"
  | "tenant_budget_exceeded"
  | "user_budget_exceeded"
  | "token_limit_exceeded"
  | "platform_budget_exceeded"
  | "rate_limited"
  | "invalid_request"
  | "provider_error"
  | "action_not_found"
  | "action_expired"
  | "action_already_executed"

const STATUS: Partial<Record<AiErrorCode, number>> = {
  unauthenticated: 401,
  invalid_request: 400,
  action_not_found: 404,
  rate_limited: 429,
  provider_error: 502,
  fallback_requires_confirmation: 409,
  action_already_executed: 409,
  action_expired: 410,
  tenant_budget_exceeded: 402,
  user_budget_exceeded: 402,
  token_limit_exceeded: 402,
  platform_budget_exceeded: 402,
}

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AiError"
  }
  get status(): number {
    return STATUS[this.code] ?? 403
  }
}
