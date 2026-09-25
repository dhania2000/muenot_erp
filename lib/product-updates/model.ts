/**
 * Spec32 (#176-179) — Versioned product updates / release notes: pure logic.
 * ---------------------------------------------------------------------------
 * No DB / server-only imports so every rule is unit-tested directly:
 *  - input validation and version normalization
 *  - a plain-text body sanitizer (no HTML is ever stored, so updates can never
 *    carry script/markup into the workspace)
 *  - audience resolution: whether a published update is visible to a given
 *    viewer, including strict tenant-specific targeting
 */

export class ProductUpdateError extends Error {
  code: string
  status: number
  constructor(message: string, code = "PRODUCT_UPDATE_ERROR", status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export const UPDATE_CATEGORIES = ["feature", "improvement", "fix", "announcement"] as const
export type UpdateCategory = (typeof UPDATE_CATEGORIES)[number]

export const AUDIENCE_TYPES = ["all", "role", "plan", "tenant"] as const
export type AudienceType = (typeof AUDIENCE_TYPES)[number]

export const UPDATE_STATUSES = ["draft", "published", "archived"] as const
export type UpdateStatus = (typeof UPDATE_STATUSES)[number]

export type AudienceConfig = {
  roles?: string[]
  plans?: string[]
  tenantIds?: number[]
}

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_+]{0,39}$/
const MAX_TITLE = 200
const MAX_BODY = 8000

/** Collapse a role token to a canonical lowercase key. */
function normRole(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : ""
}
function normPlan(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : ""
}

export function normalizeVersion(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : ""
  if (!VERSION_RE.test(v)) {
    throw new ProductUpdateError("version must be 1-40 chars: letters, digits, . - _ +", "INVALID_VERSION")
  }
  return v
}

/**
 * Strip all markup and control characters, leaving plain multi-line text.
 * Storing plain text removes every stored-XSS vector at the source.
 */
export function sanitizeBody(raw: unknown): string {
  const s = typeof raw === "string" ? raw : ""
  const text = s
    .replace(/<[^>]*>/g, " ") // drop any tags
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // control chars (keep \n, \t)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!text) throw new ProductUpdateError("body is required", "INVALID_BODY")
  return text.slice(0, MAX_BODY)
}

export function normalizeAudience(rawType: unknown, rawConfig: unknown): { audienceType: AudienceType; audienceConfig: AudienceConfig } {
  const audienceType = typeof rawType === "string" ? (rawType.trim().toLowerCase() as AudienceType) : "all"
  if (!(AUDIENCE_TYPES as readonly string[]).includes(audienceType)) {
    throw new ProductUpdateError("audienceType must be one of: all, role, plan, tenant", "INVALID_AUDIENCE")
  }
  const cfg = (rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {}) as Record<string, unknown>
  const audienceConfig: AudienceConfig = {}

  if (audienceType === "role") {
    const roles = Array.isArray(cfg.roles) ? [...new Set(cfg.roles.map(normRole).filter(Boolean))] : []
    if (roles.length === 0) throw new ProductUpdateError("Select at least one role for a role audience", "INVALID_AUDIENCE")
    audienceConfig.roles = roles
  } else if (audienceType === "plan") {
    const plans = Array.isArray(cfg.plans) ? [...new Set(cfg.plans.map(normPlan).filter(Boolean))] : []
    if (plans.length === 0) throw new ProductUpdateError("Select at least one plan for a plan audience", "INVALID_AUDIENCE")
    audienceConfig.plans = plans
  } else if (audienceType === "tenant") {
    const ids = Array.isArray(cfg.tenantIds)
      ? [...new Set(cfg.tenantIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
      : []
    if (ids.length === 0) throw new ProductUpdateError("Select at least one tenant for a tenant audience", "INVALID_AUDIENCE")
    audienceConfig.tenantIds = ids
  }
  return { audienceType, audienceConfig }
}

export type UpdateInput = {
  version: string
  title: string
  body: string
  category: UpdateCategory
  audienceType: AudienceType
  audienceConfig: AudienceConfig
}

export function validateUpdateInput(raw: unknown): UpdateInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProductUpdateError("Request body must be an object", "INVALID_INPUT")
  }
  const r = raw as Record<string, unknown>
  const version = normalizeVersion(r.version)
  const title = typeof r.title === "string" ? r.title.trim() : ""
  if (!title) throw new ProductUpdateError("title is required", "INVALID_TITLE")
  const body = sanitizeBody(r.body)
  const category = typeof r.category === "string" ? (r.category.trim().toLowerCase() as UpdateCategory) : "announcement"
  if (!(UPDATE_CATEGORIES as readonly string[]).includes(category)) {
    throw new ProductUpdateError("category must be one of: feature, improvement, fix, announcement", "INVALID_CATEGORY")
  }
  const { audienceType, audienceConfig } = normalizeAudience(r.audienceType, r.audienceConfig)
  return { version, title: title.slice(0, MAX_TITLE), body, category, audienceType, audienceConfig }
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9_\-:.]{8,80}$/

/** Validate an optional `Idempotency-Key` header. Absent → null; malformed → 400. */
export function normalizeIdempotencyKey(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return null
  const key = raw.trim()
  if (!IDEMPOTENCY_RE.test(key)) {
    throw new ProductUpdateError("Idempotency-Key must be 8-80 chars: letters, digits, _ - : .", "INVALID_IDEMPOTENCY_KEY")
  }
  return key
}

export type Viewer = {
  tenantId: number | null
  role: string
  tenantRole?: string | null
  plan?: string | null
}

export type AudienceLike = {
  status: UpdateStatus | string
  audienceType: AudienceType | string
  audienceConfig: AudienceConfig | null | undefined
}

/**
 * Whether a published update is visible to a viewer. Draft/archived updates are
 * never visible to viewers. Tenant targeting is strict: a viewer with no tenant
 * can never match a tenant-scoped update, so cross-tenant leakage is impossible.
 */
export function isUpdateVisibleTo(update: AudienceLike, viewer: Viewer): boolean {
  if (update.status !== "published") return false
  const cfg = update.audienceConfig ?? {}
  switch (update.audienceType) {
    case "all":
      return true
    case "role": {
      const roles = (cfg.roles ?? []).map((r) => r.toLowerCase())
      const viewerRoles = [viewer.role, viewer.tenantRole].filter(Boolean).map((r) => String(r).toLowerCase())
      return viewerRoles.some((r) => roles.includes(r))
    }
    case "plan": {
      const plans = (cfg.plans ?? []).map((p) => p.toLowerCase())
      const plan = (viewer.plan ?? "").toLowerCase()
      return plan !== "" && plans.includes(plan)
    }
    case "tenant": {
      if (viewer.tenantId == null) return false
      return (cfg.tenantIds ?? []).includes(viewer.tenantId)
    }
    default:
      return false
  }
}

export function parseAudienceConfig(raw: unknown): AudienceConfig {
  let obj: Record<string, unknown> | null = null
  if (raw && typeof raw === "object" && !Array.isArray(raw)) obj = raw as Record<string, unknown>
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed
    } catch {
      obj = null
    }
  }
  const out: AudienceConfig = {}
  if (!obj) return out
  if (Array.isArray(obj.roles)) out.roles = obj.roles.map(normRole).filter(Boolean)
  if (Array.isArray(obj.plans)) out.plans = obj.plans.map(normPlan).filter(Boolean)
  if (Array.isArray(obj.tenantIds)) out.tenantIds = obj.tenantIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
  return out
}
