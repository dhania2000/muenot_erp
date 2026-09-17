import "server-only"
import { getSession, type SessionPayload } from "@/lib/auth"
import { hasActionGrant } from "@/lib/permission-store"
import { canActOnRecord, canCreateInModule } from "@/lib/permission-enforce"

export const PRODUCT_KEY = "products.products"

/**
 * Resolve the current session together with the set of Product & Inventory
 * capability flags the user holds (Phase 44 extended RBAC). The UI uses these
 * flags to hide cost / margin, disable stock actions, etc., and the APIs use
 * them to gate the sensitive endpoints server-side.
 */
export type ProductCapabilities = {
  canViewCost: boolean
  canViewMargin: boolean
  canAdjustStock: boolean
  canChangeStatus: boolean
  canManageCategories: boolean
  canImportExport: boolean
  canManageSettings: boolean
  canCreate: boolean
}

async function grant(session: SessionPayload, action: string): Promise<boolean> {
  if (session.role === "admin") return true
  return hasActionGrant(session.userId, session.role, PRODUCT_KEY, action).catch(() => false)
}

export async function getProductSession(): Promise<{ session: SessionPayload; caps: ProductCapabilities } | null> {
  const session = await getSession()
  if (!session) return null
  const [
    canViewCost,
    canViewMargin,
    canAdjustStock,
    canChangeStatus,
    canManageCategories,
    canImportExport,
    canManageSettings,
    canCreate,
  ] = await Promise.all([
    grant(session, "view_cost"),
    grant(session, "view_margin"),
    grant(session, "adjust_stock"),
    grant(session, "change_status"),
    grant(session, "manage_categories"),
    grant(session, "import_export"),
    grant(session, "manage_settings"),
    canCreateInModule(session, PRODUCT_KEY).catch(() => session.role === "admin"),
  ])
  return {
    session,
    caps: {
      canViewCost,
      canViewMargin,
      canAdjustStock,
      canChangeStatus,
      canManageCategories,
      canImportExport,
      canManageSettings,
      canCreate,
    },
  }
}

export async function canViewProduct(session: SessionPayload, product: Record<string, any>): Promise<boolean> {
  return canActOnRecord(session, PRODUCT_KEY, "view", product).catch(() => session.role === "admin")
}

export async function canEditProduct(session: SessionPayload, product: Record<string, any>): Promise<boolean> {
  return canActOnRecord(session, PRODUCT_KEY, "update", product).catch(() => session.role === "admin")
}

const COST_FIELDS = ["purchase_price", "cost_price", "inventory_cost"]

/** Strip cost-sensitive fields from a product row when the user lacks view_cost. */
export function redactCost<T extends Record<string, any>>(row: T, caps: ProductCapabilities): T {
  if (caps.canViewCost) return row
  const clone: Record<string, any> = { ...row }
  for (const f of COST_FIELDS) if (f in clone) clone[f] = null
  return clone as T
}
