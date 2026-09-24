import "server-only"
/**
 * SPEC 156 — White-Label support.
 * ---------------------------------------------------------------------------
 * Commercial white-labelling has two independent conditions, and BOTH must be
 * true before vendor ("Muenot") attribution is removed from any surface:
 *
 *   1. PLAN GRANT  — the tenant's plan must include the `white_label` feature
 *      flag (see lib/platform/entitlements.ts). This is the paid entitlement.
 *   2. TENANT OPT-IN — the tenant must have turned on the `whitelabel.hide_vendor`
 *      setting (tenant-scoped override, see lib/tenant-settings.ts).
 *
 * The actual brand assets (logo, company name, colours, custom domain, email/
 * PDF/login branding) are configured through SPEC 155's Branding Engine; this
 * module only decides whether the VENDOR's own attribution is shown alongside
 * them. Because it reads the tenant-scoped settings + entitlement layers, it
 * inherits their tenant isolation and caching: one tenant's white-label state
 * can never leak into another's.
 */
import { getSettings } from "@/lib/settings/server"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getTenantEntitlements } from "@/lib/platform/entitlement-guard"
import { hasFeatureFlag, type PlanEntitlements } from "@/lib/platform/entitlements"

/** The plan-level feature flag that unlocks white-labelling. */
export const WHITE_LABEL_FLAG = "white_label"

/** The vendor whose attribution white-label removes. */
export const VENDOR = { name: "Muenot", url: "https://muenot.com" } as const

export type WhiteLabelConfig = {
  /** Does the tenant's plan include the white-label entitlement? */
  planAllows: boolean
  /** Has the tenant opted in to hiding vendor branding? */
  optedIn: boolean
  /** Effective decision: vendor attribution is removed only when BOTH are true. */
  hideVendor: boolean
  vendor: { name: string; url: string }
  /** Ready-to-render attribution text, or "" when hidden. */
  poweredByText: string
}

function truthy(v?: string): boolean {
  if (v == null) return false
  const s = v.trim().toLowerCase()
  return s === "enabled" || s === "true" || s === "1" || s === "yes" || s === "on"
}

/**
 * The pure white-label decision, isolated from any I/O so it can be unit-tested
 * exhaustively. Vendor branding is removed ONLY when the plan grants it AND the
 * tenant opted in — every other combination shows the vendor (fail-safe: a
 * tenant can never accidentally strip attribution it hasn't paid for).
 */
export function computeWhiteLabel(opts: { planAllows: boolean; optedIn: boolean }): WhiteLabelConfig {
  const planAllows = Boolean(opts.planAllows)
  const optedIn = Boolean(opts.optedIn)
  const hideVendor = planAllows && optedIn
  return {
    planAllows,
    optedIn,
    hideVendor,
    vendor: { name: VENDOR.name, url: VENDOR.url },
    poweredByText: hideVendor ? "" : `Powered by ${VENDOR.name}`,
  }
}

/** Resolve whether a plan grants the white-label entitlement. */
export function planAllowsWhiteLabel(ent: PlanEntitlements): boolean {
  return hasFeatureFlag(ent, WHITE_LABEL_FLAG)
}

/**
 * Resolve the effective white-label configuration for the tenant in the current
 * async context. Safe to call anywhere server-side:
 *   • With a tenant in context (authenticated app, emails, PDFs) it resolves the
 *     plan grant + opt-in and gates accordingly.
 *   • With no tenant (pre-auth, e.g. the public login screen) it fails safe to
 *     "vendor shown" — attribution is never removed without a verified plan.
 * Never throws: any settings/entitlement failure degrades to vendor shown.
 */
export async function getWhiteLabel(): Promise<WhiteLabelConfig> {
  const tenantId = currentTenantIdOrNull()

  let optedIn = false
  try {
    optedIn = truthy((await getSettings())["whitelabel.hide_vendor"])
  } catch {
    optedIn = false
  }

  let planAllows = false
  if (tenantId != null) {
    try {
      planAllows = planAllowsWhiteLabel(await getTenantEntitlements(tenantId))
    } catch {
      planAllows = false
    }
  }

  return computeWhiteLabel({ planAllows, optedIn })
}
