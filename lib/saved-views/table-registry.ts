/**
 * Saved-view table registry: which feature a user must hold to list or save
 * views for a given table. A view config reveals which columns/filters exist,
 * and shared views are visible tenant-wide, so they are gated by the same
 * feature that gates the underlying list endpoint.
 *
 * Unregistered (but well-formed) table keys stay usable for personal views
 * only, so new tables can adopt saved views before being registered here.
 */

export const TABLE_KEY_RE = /^[a-z][a-z0-9._-]{1,95}$/

export const SAVED_VIEW_TABLES: Record<string, { feature: string }> = {
  clients: { feature: "clients.view_clients" },
  "sales.companies": { feature: "sales.view_companies" },
  "sales.leads": { feature: "sales.view_leads" },
  "sales.deals": { feature: "sales.view_deals" },
}

export function isValidTableKey(key: unknown): key is string {
  return typeof key === "string" && TABLE_KEY_RE.test(key)
}

export function featureForTable(key: string): string | null {
  return SAVED_VIEW_TABLES[key]?.feature ?? null
}
