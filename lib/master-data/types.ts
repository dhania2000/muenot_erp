/**
 * SPEC 90 — Centralized Master Data: shared types.
 * ---------------------------------------------------------------------------
 * A "master" is a reusable reference list that many modules point at (a
 * country, a currency, a cost centre, a payment term…). Before this module
 * each of these lived either as a free-text VARCHAR duplicated across module
 * tables, or as an isolated per-module table. This module gives every master a
 * single canonical home and a uniform access contract.
 */

/** Every master the platform recognizes. */
export type MasterKind =
  | "countries"
  | "states"
  | "cities"
  | "currencies"
  | "tax_codes"
  | "departments"
  | "designations"
  | "cost_centers"
  | "locations"
  | "units"
  | "payment_terms"
  | "approval_levels"
  | "categories"

/**
 * How a master is backed:
 *  - "global"    : platform-wide reference catalogue, no tenant_id (like the
 *                  modules/features catalogue). Shared by every tenant.
 *  - "tenant"    : tenant-owned business data (carries tenant_id, guarded).
 *  - "delegated" : an existing module table is already the source of truth; the
 *                  canonical service reads through to it for backward compat.
 */
export type MasterMode = "global" | "tenant" | "delegated"

/** A single normalized master row exposed to callers, regardless of backing. */
export type MasterRow = {
  /** Stable business code used as the cross-module reference (e.g. "IN", "INR", "CC-OPS"). */
  code: string
  /** Human label. */
  name: string
  /** Whether the value is selectable. Inactive values stay resolvable for history. */
  active: boolean
  /** Optional parent code for hierarchical masters (state → country, city → state). */
  parent?: string | null
  /** Free-form extra attributes (symbol, rate, dial code, level number…). */
  meta?: Record<string, unknown>
}

/** Backing configuration for one master kind. */
export type MasterSource = {
  kind: MasterKind
  mode: MasterMode
  /** Physical table the values live in. */
  table: string
  /** Column holding the business code. */
  codeCol: string
  /** Column holding the display name. */
  nameCol: string
  /** Column (and truthy-active semantics) used for the active flag. */
  activeCol: string
  activeTrue: string
  /** Optional parent code column for hierarchical masters. */
  parentCol?: string
  /** Columns copied verbatim into `meta`. */
  metaCols?: string[]
  /** True when the caller must supply a tenantId (mode === "tenant"). */
  tenantScoped: boolean
  /** Whether writes are accepted here. Delegated masters are read-only via this service. */
  writable: boolean
  /** Human note describing what previously duplicated this master (Phase 1 audit). */
  note: string
}
