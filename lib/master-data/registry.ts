/**
 * SPEC 90 — Centralized Master Data: source registry (Phase 1 → Phase 3).
 * ---------------------------------------------------------------------------
 * This registry is the machine-readable result of the Phase 1 audit: for every
 * master it records WHERE the canonical value now lives and WHAT previously
 * duplicated it. The service (service.ts) reads this to route every call, so
 * modules never need to know whether a master is a brand-new canonical table
 * or an existing source-of-truth table being delegated to.
 *
 * Design rules:
 *  - Geo + currency + unit reference data is GLOBAL (shared catalogue, no
 *    tenant_id) — the same way modules/features are shared platform-wide.
 *  - Business data that differs per customer (cost centres, locations,
 *    categories) is TENANT-owned and guarded.
 *  - Where a mature module already owns a master (HR departments/designations,
 *    finance tax codes) we DELEGATE to it instead of forking a second source of
 *    truth. Those stay read-only through this service.
 */
import type { MasterKind, MasterSource } from "./types"

export const MASTER_SOURCES: Record<MasterKind, MasterSource> = {
  countries: {
    kind: "countries",
    mode: "global",
    table: "md_countries",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    metaCols: ["iso3", "dial_code", "currency_code"],
    tenantScoped: false,
    writable: true,
    note: "Was free-text `country` VARCHAR on clients + finance/HR tables.",
  },
  states: {
    kind: "states",
    mode: "global",
    table: "md_states",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    parentCol: "country_code",
    tenantScoped: false,
    writable: true,
    note: "Was free-text `state` / `applicable_state_ut` VARCHAR columns.",
  },
  cities: {
    kind: "cities",
    mode: "global",
    table: "md_cities",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    parentCol: "state_code",
    tenantScoped: false,
    writable: true,
    note: "Was free-text `city` VARCHAR on clients and address blocks.",
  },
  currencies: {
    kind: "currencies",
    mode: "global",
    table: "md_currencies",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    metaCols: ["symbol", "decimals"],
    tenantScoped: false,
    writable: true,
    note: "Was free-text `currency` VARCHAR on clients, finance_products, billing.",
  },
  units: {
    kind: "units",
    mode: "global",
    table: "md_units",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    metaCols: ["dimension"],
    tenantScoped: false,
    writable: true,
    note: "Was free-text `unit` VARCHAR on finance_products / invoice lines.",
  },
  payment_terms: {
    kind: "payment_terms",
    mode: "global",
    table: "md_payment_terms",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    metaCols: ["net_days"],
    tenantScoped: false,
    writable: true,
    note: "Was `payment_terms_days` INT on clients + finance bills/expenses.",
  },
  approval_levels: {
    kind: "approval_levels",
    mode: "global",
    table: "md_approval_levels",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    metaCols: ["level_no"],
    tenantScoped: false,
    writable: true,
    note: "Was embedded in company_settings approval config.",
  },
  cost_centers: {
    kind: "cost_centers",
    mode: "tenant",
    table: "md_cost_centers",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    tenantScoped: true,
    writable: true,
    note: "Was free-text `cost_centre` VARCHAR across finance journal/expenses/assets.",
  },
  locations: {
    kind: "locations",
    mode: "tenant",
    table: "md_locations",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    metaCols: ["city_code", "state_code", "country_code"],
    tenantScoped: true,
    writable: true,
    note: "Was ad-hoc address/branch strings per module.",
  },
  categories: {
    kind: "categories",
    mode: "tenant",
    table: "md_categories",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    parentCol: "domain",
    metaCols: ["domain", "color"],
    tenantScoped: true,
    writable: true,
    note: "Was many disjoint tables: hr_support_categories, kb_categories, notice_categories, product_categories.",
  },
  // --- Delegated: existing modules remain the source of truth ---------------
  departments: {
    kind: "departments",
    mode: "delegated",
    table: "hr_departments",
    codeCol: "department_id",
    nameCol: "department_name",
    activeCol: "status",
    activeTrue: "Active",
    parentCol: "parent_department_id",
    tenantScoped: false,
    writable: false,
    note: "Delegated to HR module (lib/hr-master-data.ts) — single source of truth.",
  },
  designations: {
    kind: "designations",
    mode: "delegated",
    table: "hr_designations",
    codeCol: "designation_id",
    nameCol: "designation_name",
    activeCol: "status",
    activeTrue: "Active",
    parentCol: "parent_designation_id",
    tenantScoped: false,
    writable: false,
    note: "Delegated to HR module (lib/hr-master-data.ts) — single source of truth.",
  },
  tax_codes: {
    kind: "tax_codes",
    mode: "delegated",
    table: "finance_tax_rates",
    codeCol: "code",
    nameCol: "name",
    activeCol: "is_active",
    activeTrue: "1",
    metaCols: ["rate", "cess_rate", "category"],
    tenantScoped: false,
    writable: false,
    note: "Delegated to finance module (lib/finance-masters.ts) — invoice posting stays authoritative.",
  },
}

export const MASTER_KINDS = Object.keys(MASTER_SOURCES) as MasterKind[]

export function getMasterSource(kind: MasterKind): MasterSource {
  const src = MASTER_SOURCES[kind]
  if (!src) throw new Error(`Unknown master kind: ${kind}`)
  return src
}
