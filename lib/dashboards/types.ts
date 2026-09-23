/**
 * Enterprise Dashboard Engine: shared types.
 *
 * These types are imported by both server (catalog/store/API) and client
 * (engine UI), so this module must stay free of any server-only imports.
 */

export type DashboardScope = "personal" | "role" | "tenant"
export type WidgetType = "kpi" | "chart" | "table"
export type ChartKind = "bar" | "line" | "area" | "pie"

/** The role keys a role-scoped dashboard can target. */
export const ROLE_KEYS = ["employee", "module_admin", "tenant_admin", "tenant_owner"] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

export const ROLE_KEY_LABELS: Record<string, string> = {
  employee: "Employees",
  module_admin: "Module admins",
  tenant_admin: "Tenant admins",
  tenant_owner: "Tenant owners",
}

/** Which global filters a widget consumes. */
export type WidgetFilterKey = "dateRange" | "department"

/** Date-range presets offered in the filter bar. */
export const DATE_PRESETS = [
  { value: "last_7", label: "Last 7 days" },
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "this_year", label: "This year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
] as const

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Resolve a preset id into concrete from/to ISO dates (null = unbounded). */
export function resolveDatePreset(preset: string): { from: string | null; to: string | null } {
  const now = new Date()
  const today = iso(now)
  switch (preset) {
    case "last_7": {
      const from = new Date(now)
      from.setDate(from.getDate() - 6)
      return { from: iso(from), to: today }
    }
    case "last_30": {
      const from = new Date(now)
      from.setDate(from.getDate() - 29)
      return { from: iso(from), to: today }
    }
    case "last_90": {
      const from = new Date(now)
      from.setDate(from.getDate() - 89)
      return { from: iso(from), to: today }
    }
    case "this_month":
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case "this_year":
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: today }
    case "all":
      return { from: null, to: null }
    default:
      return { from: null, to: null }
  }
}

export type DashboardFilters = {
  /** Client-side preset id, e.g. "last_30". "custom" uses from/to as-is. */
  preset?: string
  from?: string | null
  to?: string | null
  department?: string | null
  /** Entity filter: module slugs to keep visible. Empty/null = show all. */
  modules?: string[] | null
}

export type WidgetInstance = {
  /** Stable per-instance id so the same widget can appear more than once. */
  id: string
  /** Catalog key the instance renders. */
  key: string
}

export type DashboardConfig = {
  widgets: WidgetInstance[]
  filters: DashboardFilters
}

export type DashboardRecord = {
  id: number
  name: string
  scope: DashboardScope
  roleKey: string | null
  ownerUserId: number | null
  isDefault: boolean
  config: DashboardConfig
  /** Whether the requesting user may edit/delete this dashboard. */
  canEdit: boolean
}

export type WidgetCatalogEntry = {
  key: string
  title: string
  description: string
  module: string
  moduleSlug: string
  type: WidgetType
  chart?: ChartKind
  filters: WidgetFilterKey[]
  size: "sm" | "md" | "lg"
}

// --- Resolved widget data (what the data endpoint returns per widget) -------

export type KpiTone = "default" | "positive" | "warning" | "critical"
export type KpiItem = { label: string; value: string | number; hint?: string | null; tone?: KpiTone }
export type ChartSeries = { key: string; label: string; color: string }
export type TableColumn = { key: string; label: string; align?: "left" | "right" }

export type WidgetData =
  | { kind: "kpi"; items: KpiItem[] }
  | {
      kind: "chart"
      chart: ChartKind
      xKey: string
      series: ChartSeries[]
      points: Record<string, unknown>[]
    }
  | { kind: "table"; columns: TableColumn[]; rows: Record<string, unknown>[] }
  | { kind: "empty"; message: string }

export type DashboardOptions = {
  departments: string[]
  modules: { slug: string; label: string }[]
}

export type DashboardBootstrap = {
  dashboards: DashboardRecord[]
  catalog: WidgetCatalogEntry[]
  options: DashboardOptions
  permissions: { canManageShared: boolean }
}
