import "server-only"
import { normalizeGstin, stateCodeFromGstin, GST_STATE_CODES } from "@/lib/gstin"

/**
 * Platform seller identity for the SaaS provider's own GST invoices (#81-83).
 * ---------------------------------------------------------------------------
 * Muenot is the SELLER when it bills a customer tenant for their ERP
 * subscription. Its own GSTIN — and therefore the seller's state — is a single
 * platform-wide value, distinct from any customer's GSTIN. It is sourced from
 * the `PLATFORM_SELLER_GSTIN` environment variable so the deployment controls
 * it; when unset, invoices simply carry no seller GSTIN and the supply defaults
 * to inter-state (a single IGST levy), which is the conservative GST treatment.
 *
 * Place of supply for a B2B SaaS service is the customer's registered state,
 * taken from their GSTIN where present, otherwise mapped from their billing
 * state name. This module is the one place that turns billing inputs into the
 * two-digit GST state codes the pure `saas-gst` splitter consumes.
 */

/** The platform's own normalized GSTIN, or "" when not configured. */
export function getSellerGstin(): string {
  return normalizeGstin(process.env.PLATFORM_SELLER_GSTIN ?? "")
}

/** Two-digit GST state code of the seller (platform), or null when unknown. */
export function getSellerStateCode(): string | null {
  const g = getSellerGstin()
  return g ? stateCodeFromGstin(g) : null
}

/** Reverse the GST state-name map to a two-digit code (case-insensitive). */
function stateCodeFromName(name: string | null | undefined): string | null {
  const n = String(name ?? "").trim().toLowerCase()
  if (!n) return null
  const hit = Object.entries(GST_STATE_CODES).find(([, label]) => label.toLowerCase() === n)
  return hit ? hit[0] : null
}

/**
 * Resolve the place of supply (state code + display name) for a customer from
 * their tax id (GSTIN) first, falling back to the billing state name. The code
 * drives the IGST vs CGST/SGST decision; the name is stored for the invoice.
 */
export function resolvePlaceOfSupply(input: {
  taxId?: string | null
  state?: string | null
}): { code: string | null; name: string | null } {
  const gstin = input.taxId ? normalizeGstin(input.taxId) : ""
  const fromGstin = gstin ? stateCodeFromGstin(gstin) : null
  if (fromGstin) {
    return { code: fromGstin, name: GST_STATE_CODES[fromGstin] ?? input.state?.trim() ?? null }
  }
  const name = input.state?.trim() || null
  const fromName = stateCodeFromName(name)
  if (fromName) return { code: fromName, name: GST_STATE_CODES[fromName] ?? name }
  return { code: null, name }
}
