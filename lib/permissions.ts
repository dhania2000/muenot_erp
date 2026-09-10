import { query } from "./db"
import { getUserMatrix } from "./permission-store"
import { PERMISSION_MODULES, resolveFeatureSlug, type PermissionMatrix } from "./permission-model"

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

/** Legacy: feature slugs granted to a user via the old user_permissions table. */
export async function getUserFeatureSlugs(userId: number): Promise<string[]> {
  const rows = await query<{ slug: string }[]>(
    `SELECT f.slug FROM user_permissions up
     JOIN features f ON f.id = up.feature_id
     WHERE up.user_id = ?`,
    [userId],
  )
  return rows.map((r) => r.slug)
}

/** Does the matrix grant the given feature slug? Returns null if slug is unmapped. */
function matrixGrantsSlug(matrix: PermissionMatrix, slug: string): boolean | null {
  const resolved = resolveFeatureSlug(slug)
  if (!resolved) return null
  const perm = matrix[resolved.moduleKey]
  if (!perm) return null
  if (resolved.action === "view") {
    // Any level of access to the module implies it can be viewed.
    return perm.view !== "none" || perm.add !== "none" || perm.update !== "none" || perm.delete !== "none"
  }
  // "manage"-style features require some write capability.
  return perm.add !== "none" || perm.update !== "none" || perm.delete !== "none"
}

/** True if the group (top-level module) has any visible permission for the user. */
function matrixGroupVisible(matrix: PermissionMatrix, groupSlug: string): boolean {
  return PERMISSION_MODULES.filter((m) => m.group === groupSlug).some((m) => {
    const p = matrix[m.key]
    return p && (p.view !== "none" || p.add !== "none" || p.update !== "none" || p.delete !== "none")
  })
}

export async function userHasFeature(userId: number, role: "admin" | "employee", featureSlug: string) {
  if (role === "admin") return true

  const matrix = await getUserMatrix(userId)
  if (matrix) {
    const granted = matrixGrantsSlug(matrix, featureSlug)
    if (granted !== null) return granted
    // Unmapped slug — fall back to group-level visibility so we neither
    // over-expose nor accidentally hide a whole section.
    const group = featureSlug.split(".")[0]
    return matrixGroupVisible(matrix, group)
  }

  // No matrix configured — use the legacy feature grants.
  const rows = await query<{ id: number }[]>(
    `SELECT up.id FROM user_permissions up
     JOIN features f ON f.id = up.feature_id
     WHERE up.user_id = ? AND f.slug = ? LIMIT 1`,
    [userId, featureSlug],
  )
  return rows.length > 0
}

/**
 * Build a synchronous predicate that answers "does this user have feature slug X?".
 * Fetches the permission matrix once so it can be called many times (e.g. while
 * building the sidebar) without extra DB round-trips. Mirrors `userHasFeature`:
 * matrix first (with group-visibility fallback for unmapped slugs), then the
 * legacy feature grants when no matrix is configured.
 */
export async function getFeatureChecker(
  userId: number,
  role: "admin" | "employee",
): Promise<(featureSlug: string) => boolean> {
  if (role === "admin") return () => true

  const matrix = await getUserMatrix(userId)
  if (matrix) {
    return (featureSlug: string) => {
      const granted = matrixGrantsSlug(matrix, featureSlug)
      if (granted !== null) return granted
      const group = featureSlug.split(".")[0]
      return matrixGroupVisible(matrix, group)
    }
  }

  const legacy = new Set(await getUserFeatureSlugs(userId))
  return (featureSlug: string) => legacy.has(featureSlug)
}

/** Modules (with only the features the user can access) for a given user. Admins get everything. */
export async function getUserAccessibleModules(userId: number, role: "admin" | "employee") {
  const allModules = await getAllModulesWithFeatures()
  if (role === "admin") return allModules

  const matrix = await getUserMatrix(userId)

  if (matrix) {
    return allModules
      .map((m) => ({
        ...m,
        features: m.features.filter((f) => {
          const granted = matrixGrantsSlug(matrix, f.slug)
          return granted === null ? matrixGroupVisible(matrix, m.slug) : granted
        }),
      }))
      .filter((m) => m.features.length > 0 || matrixGroupVisible(matrix, m.slug))
  }

  // Legacy fallback.
  const granted = new Set(await getUserFeatureSlugs(userId))
  return allModules
    .map((m) => ({ ...m, features: m.features.filter((f) => granted.has(f.slug)) }))
    .filter((m) => m.features.length > 0)
}

/** Legacy setter kept for backward compatibility with the old permissions dialog. */
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
