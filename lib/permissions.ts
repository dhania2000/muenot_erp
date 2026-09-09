import { query } from "./db"

export type ModuleRow = {
  id: number
  name: string
  slug: string
  description: string | null
  icon: string | null
  sort_order: number
}

export type FeatureRow = {
  id: number
  module_id: number
  name: string
  slug: string
  description: string | null
  sort_order: number
}

/** All modules with their features, in display order. */
export async function getAllModulesWithFeatures() {
  const modules = await query<ModuleRow[]>("SELECT * FROM modules ORDER BY sort_order ASC")
  const features = await query<FeatureRow[]>("SELECT * FROM features ORDER BY sort_order ASC")
  return modules.map((m) => ({
    ...m,
    features: features.filter((f) => f.module_id === m.id),
  }))
}

/** Feature slugs a given user has been granted. */
export async function getUserFeatureSlugs(userId: number): Promise<string[]> {
  const rows = await query<{ slug: string }[]>(
    `SELECT f.slug FROM user_permissions up
     JOIN features f ON f.id = up.feature_id
     WHERE up.user_id = ?`,
    [userId],
  )
  return rows.map((r) => r.slug)
}

/** Modules (with only the features the user can access) for a given user. Admins get everything. */
export async function getUserAccessibleModules(userId: number, role: "admin" | "employee") {
  const allModules = await getAllModulesWithFeatures()
  if (role === "admin") return allModules

  const granted = new Set(await getUserFeatureSlugs(userId))
  return allModules
    .map((m) => ({ ...m, features: m.features.filter((f) => granted.has(f.slug)) }))
    .filter((m) => m.features.length > 0)
}

export async function userHasFeature(userId: number, role: "admin" | "employee", featureSlug: string) {
  if (role === "admin") return true
  const rows = await query<{ id: number }[]>(
    `SELECT up.id FROM user_permissions up
     JOIN features f ON f.id = up.feature_id
     WHERE up.user_id = ? AND f.slug = ? LIMIT 1`,
    [userId, featureSlug],
  )
  return rows.length > 0
}

export async function setUserPermissions(userId: number, featureIds: number[], grantedBy: number) {
  await query("DELETE FROM user_permissions WHERE user_id = ?", [userId])
  if (featureIds.length === 0) return
  const values = featureIds.map((fid) => [userId, fid, grantedBy])
  await query(
    `INSERT INTO user_permissions (user_id, feature_id, granted_by) VALUES ${values
      .map(() => "(?, ?, ?)")
      .join(", ")}`,
    values.flat(),
  )
}
