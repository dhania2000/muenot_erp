import "server-only"
import { query } from "@/lib/db"
import { getSession, type SessionUser } from "@/lib/auth"
import { MODULES } from "@/lib/modules"

export type AccessRow = { module_key: string; feature_key: string; can_view: number; can_edit: number }

export type Access = {
  canView: (moduleKey: string, featureKey: string) => boolean
  canEdit: (moduleKey: string, featureKey: string) => boolean
  isAdmin: boolean
}

// Loads a user's permission set. Admins implicitly have full access.
export async function getAccessFor(user: SessionUser): Promise<Access> {
  if (user.role === "admin") {
    return { isAdmin: true, canView: () => true, canEdit: () => true }
  }
  const rows = await query<AccessRow>(
    "SELECT module_key, feature_key, can_view, can_edit FROM user_access WHERE user_id = ?",
    [user.id],
  )
  const map = new Map<string, AccessRow>()
  for (const r of rows) map.set(`${r.module_key}.${r.feature_key}`, r)
  return {
    isAdmin: false,
    canView: (m, f) => !!map.get(`${m}.${f}`)?.can_view,
    canEdit: (m, f) => !!map.get(`${m}.${f}`)?.can_edit,
  }
}

// Combined session + access loader for pages.
export async function getAuthContext() {
  const user = await getSession()
  if (!user) return null
  const access = await getAccessFor(user)
  return { user, access }
}

// Returns the modules/features the current user is allowed to see, for the sidebar.
export function visibleNav(access: Access) {
  return MODULES.map((m) => ({
    ...m,
    features: m.features.filter((f) => access.canView(m.key, f.key)),
  })).filter((m) => m.features.length > 0)
}
