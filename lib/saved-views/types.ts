/**
 * Saved Views: shared types.
 *
 * A "saved view" captures a table's presentation preferences — search text,
 * filters, column order/visibility, sorting, grouping and page size — so users
 * can switch between reusable configurations of the same table.
 *
 * This module is imported by both the server (store/API) and the client
 * (reusable hook + toolbar), so it MUST stay free of any server-only imports.
 */

/** Where a saved view is visible / who it is shared with. */
export type ViewVisibility = "private" | "public" | "role" | "team"

export const VIEW_VISIBILITIES: ViewVisibility[] = ["private", "public", "role", "team"]

export const VIEW_VISIBILITY_LABELS: Record<ViewVisibility, string> = {
  private: "Private",
  public: "Everyone (tenant)",
  role: "Shared with a role",
  team: "Shared with a team",
}

/** Role keys a role-shared view can target (mirrors the tenant role axis). */
export const ROLE_KEYS = ["employee", "module_admin", "tenant_admin", "tenant_owner"] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

export const ROLE_KEY_LABELS: Record<string, string> = {
  employee: "Employees",
  module_admin: "Module admins",
  tenant_admin: "Tenant admins",
  tenant_owner: "Tenant owners",
}

export type SortDirection = "asc" | "desc"

/**
 * Column resize bounds (in px). Widths outside this range are clamped both on
 * the client (while dragging) and on the server (when persisting a view), so a
 * saved view can never make a column unusably narrow or absurdly wide.
 */
export const MIN_COLUMN_WIDTH = 64
export const MAX_COLUMN_WIDTH = 800
/** Fallback width used for offset math when a pinned column has no saved width. */
export const DEFAULT_COLUMN_WIDTH = 180

/** One column-level preference: position is implied by array order. */
export type ColumnPref = {
  key: string
  hidden?: boolean
  /** Persisted pixel width from a resize; clamped to [MIN,MAX]_COLUMN_WIDTH. */
  width?: number
  /** Pinned (frozen) to the left edge so it stays visible while scrolling. */
  pinned?: boolean
}

export type SortRule = {
  key: string
  dir: SortDirection
}

/**
 * The serializable state a saved view stores. Every field is optional so a
 * partial view degrades gracefully against a table whose columns changed.
 */
export type TableViewConfig = {
  search?: string
  /** Arbitrary named filters; values are scalars or scalar arrays. */
  filters?: Record<string, string | string[] | null>
  /** Ordered column preferences (order + visibility). */
  columns?: ColumnPref[]
  sort?: SortRule[]
  groupBy?: string | null
  pageSize?: number
}

export type SavedViewRecord = {
  id: number
  tableKey: string
  name: string
  visibility: ViewVisibility
  roleKey: string | null
  teamKey: string | null
  ownerUserId: number | null
  isDefault: boolean
  config: TableViewConfig
  /** Whether the requesting user may edit / delete this view. */
  canEdit: boolean
}

/** Metadata a table hands to the reusable toolbar so it can render controls. */
export type ViewColumnDef = {
  key: string
  label: string
  sortable?: boolean
  /** Columns that can be used as a grouping key. */
  groupable?: boolean
  defaultHidden?: boolean
}

export type SavedViewsBootstrap = {
  views: SavedViewRecord[]
  permissions: { canManageShared: boolean }
  /** Role keys the viewer can target when sharing to a role. */
  roles: { key: string; label: string }[]
  /** Teams (departments) the viewer belongs to and can share to. */
  teams: string[]
}

export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100] as const
