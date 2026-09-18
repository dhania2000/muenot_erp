import { query } from "./db"
import {
  PERMISSION_MODULES,
  mergeMatrices,
  type PermissionMatrix,
  type PermissionScope,
} from "./permission-model"

/**
 * SPEC 8 — Custom roles.
 * ---------------------------------------------------------------------------
 * Reusable, tenant-scoped named roles that carry a permission matrix (the same
 * Add/View/Update/Delete + extended-action model used per-user). A user can be
 * assigned any number of roles; their effective permissions are the
 * most-permissive union of every assigned role PLUS any per-user override
 * matrix (see lib/permission-store.ts#getEffectiveUserMatrix).
 *
 * Roles are additive layers on top of the existing per-user matrix — nothing
 * about the legacy behaviour changes for users who have neither a role nor a
 * personal matrix (they still fall back to full access / legacy feature grants).
 *
 * Tenant isolation: every role read/write is scoped by `tenant_id`, always
 * derived from the verified session (never client input).
 */

let schemaEnsured = false

/** Self-healing schema — creates the custom-role tables if they don't exist. */
export async function ensureRoleSchema() {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS custom_roles (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      name VARCHAR(120) NOT NULL,
      description VARCHAR(400) DEFAULT NULL,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_tenant_role_name (tenant_id, name),
      KEY idx_custom_roles_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS role_module_permissions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      role_id INT UNSIGNED NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      can_add ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      can_view ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      can_update ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      can_delete ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      PRIMARY KEY (id),
      UNIQUE KEY uniq_role_module (role_id, module_key),
      KEY idx_rmp_role (role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS role_module_action_permissions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      role_id INT UNSIGNED NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      action_key VARCHAR(60) NOT NULL,
      scope ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      PRIMARY KEY (id),
      UNIQUE KEY uniq_role_module_action (role_id, module_key, action_key),
      KEY idx_rmap_role (role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS user_custom_roles (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      role_id INT UNSIGNED NOT NULL,
      assigned_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_role (user_id, role_id),
      KEY idx_ucr_user (user_id),
      KEY idx_ucr_role (role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  schemaEnsured = true
}

export type CustomRole = {
  id: number
  name: string
  description: string | null
  isSystem: boolean
  memberCount: number
  createdAt: string
  updatedAt: string
}

const VALID_SCOPES = new Set<PermissionScope>(["none", "all", "added", "owned", "both"])
const clamp = (v: unknown): PermissionScope => (VALID_SCOPES.has(v as PermissionScope) ? (v as PermissionScope) : "none")

/** List every custom role for a tenant, with how many users hold each. */
export async function listRoles(tenantId: number): Promise<CustomRole[]> {
  await ensureRoleSchema()
  const rows = await query<
    {
      id: number
      name: string
      description: string | null
      is_system: number
      member_count: number
      created_at: string
      updated_at: string
    }[]
  >(
    `SELECT r.id, r.name, r.description, r.is_system,
            (SELECT COUNT(*) FROM user_custom_roles ucr WHERE ucr.role_id = r.id) AS member_count,
            r.created_at, r.updated_at
       FROM custom_roles r
      WHERE r.tenant_id = ?
      ORDER BY r.name ASC`,
    [tenantId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isSystem: Boolean(r.is_system),
    memberCount: Number(r.member_count) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

/** A single role's metadata (tenant-scoped), or null when not found. */
export async function getRole(tenantId: number, roleId: number): Promise<CustomRole | null> {
  await ensureRoleSchema()
  const rows = await listRoles(tenantId)
  return rows.find((r) => r.id === roleId) ?? null
}

/** Create a role. Returns the new id. Throws on duplicate name (per tenant). */
export async function createRole(
  tenantId: number,
  input: { name: string; description?: string | null },
  createdBy: number,
): Promise<number> {
  await ensureRoleSchema()
  const res = await query<{ insertId: number }>(
    `INSERT INTO custom_roles (tenant_id, name, description, created_by) VALUES (?, ?, ?, ?)`,
    [tenantId, input.name.trim(), input.description?.trim() || null, createdBy],
  )
  return (res as any).insertId as number
}

/** Update a role's name/description (tenant-scoped, no-op cross-tenant). */
export async function updateRoleMeta(
  tenantId: number,
  roleId: number,
  input: { name?: string; description?: string | null },
): Promise<void> {
  await ensureRoleSchema()
  const sets: string[] = []
  const params: any[] = []
  if (input.name !== undefined) {
    sets.push("name = ?")
    params.push(input.name.trim())
  }
  if (input.description !== undefined) {
    sets.push("description = ?")
    params.push(input.description?.trim() || null)
  }
  if (sets.length === 0) return
  params.push(tenantId, roleId)
  await query(`UPDATE custom_roles SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`, params)
}

/** Delete a role and all its permission rows / assignments (tenant-scoped). */
export async function deleteRole(tenantId: number, roleId: number): Promise<void> {
  await ensureRoleSchema()
  // Verify ownership before touching the child tables (which have no tenant_id).
  const owned = await query<{ id: number }[]>(
    `SELECT id FROM custom_roles WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, roleId],
  )
  if (owned.length === 0) return
  await query(`DELETE FROM role_module_permissions WHERE role_id = ?`, [roleId])
  await query(`DELETE FROM role_module_action_permissions WHERE role_id = ?`, [roleId])
  await query(`DELETE FROM user_custom_roles WHERE role_id = ?`, [roleId])
  await query(`DELETE FROM custom_roles WHERE tenant_id = ? AND id = ?`, [tenantId, roleId])
}

/** The permission matrix stored on a role (tenant-scoped). */
export async function getRoleMatrix(tenantId: number, roleId: number): Promise<PermissionMatrix> {
  await ensureRoleSchema()
  const owned = await query<{ id: number }[]>(
    `SELECT id FROM custom_roles WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, roleId],
  )
  if (owned.length === 0) return {}
  const rows = await query<
    {
      module_key: string
      can_add: PermissionScope
      can_view: PermissionScope
      can_update: PermissionScope
      can_delete: PermissionScope
    }[]
  >(
    `SELECT module_key, can_add, can_view, can_update, can_delete
       FROM role_module_permissions WHERE role_id = ?`,
    [roleId],
  )
  const matrix: PermissionMatrix = {}
  for (const r of rows) {
    matrix[r.module_key] = { add: r.can_add, view: r.can_view, update: r.can_update, delete: r.can_delete }
  }
  const actionRows = await query<{ module_key: string; action_key: string; scope: PermissionScope }[]>(
    `SELECT module_key, action_key, scope FROM role_module_action_permissions WHERE role_id = ?`,
    [roleId],
  )
  for (const r of actionRows) {
    if (!matrix[r.module_key]) matrix[r.module_key] = { add: "none", view: "none", update: "none", delete: "none" }
    const mod = matrix[r.module_key]
    if (!mod.extra) mod.extra = {}
    mod.extra[r.action_key] = r.scope
  }
  return matrix
}

/** Replace the entire permission matrix stored on a role (tenant-scoped). */
export async function setRoleMatrix(tenantId: number, roleId: number, matrix: PermissionMatrix): Promise<void> {
  await ensureRoleSchema()
  const owned = await query<{ id: number }[]>(
    `SELECT id FROM custom_roles WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, roleId],
  )
  if (owned.length === 0) return

  const rows: [number, string, string, string, string, string][] = []
  for (const mod of PERMISSION_MODULES) {
    const p = matrix[mod.key]
    if (!p) continue
    rows.push([roleId, mod.key, clamp(p.add), clamp(p.view), clamp(p.update), clamp(p.delete)])
  }
  await query("DELETE FROM role_module_permissions WHERE role_id = ?", [roleId])
  if (rows.length > 0) {
    await query(
      `INSERT INTO role_module_permissions
         (role_id, module_key, can_add, can_view, can_update, can_delete)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      rows.flat(),
    )
  }

  const actionRows: [number, string, string, string][] = []
  for (const mod of PERMISSION_MODULES) {
    const p = matrix[mod.key]
    if (!p?.extra || !mod.extraActions) continue
    for (const ext of mod.extraActions) {
      const v = p.extra[ext.key]
      if (v === undefined) continue
      actionRows.push([roleId, mod.key, ext.key, clamp(v)])
    }
  }
  await query("DELETE FROM role_module_action_permissions WHERE role_id = ?", [roleId])
  if (actionRows.length > 0) {
    await query(
      `INSERT INTO role_module_action_permissions (role_id, module_key, action_key, scope)
       VALUES ${actionRows.map(() => "(?, ?, ?, ?)").join(", ")}`,
      actionRows.flat(),
    )
  }
}

/** The role ids currently assigned to a user (within the tenant). */
export async function getUserRoleIds(tenantId: number, userId: number): Promise<number[]> {
  await ensureRoleSchema()
  const rows = await query<{ role_id: number }[]>(
    `SELECT ucr.role_id
       FROM user_custom_roles ucr
       JOIN custom_roles r ON r.id = ucr.role_id AND r.tenant_id = ?
      WHERE ucr.user_id = ?`,
    [tenantId, userId],
  )
  return rows.map((r) => r.role_id)
}

/** Replace the set of roles assigned to a user (tenant-scoped, validated). */
export async function setUserRoles(
  tenantId: number,
  userId: number,
  roleIds: number[],
  assignedBy: number,
): Promise<void> {
  await ensureRoleSchema()
  // Only keep role ids that actually belong to this tenant.
  const valid =
    roleIds.length === 0
      ? []
      : (
          await query<{ id: number }[]>(
            `SELECT id FROM custom_roles WHERE tenant_id = ? AND id IN (${roleIds.map(() => "?").join(",")})`,
            [tenantId, ...roleIds],
          )
        ).map((r) => r.id)

  await query("DELETE FROM user_custom_roles WHERE user_id = ?", [userId])
  if (valid.length > 0) {
    await query(
      `INSERT INTO user_custom_roles (user_id, role_id, assigned_by)
       VALUES ${valid.map(() => "(?, ?, ?)").join(", ")}`,
      valid.flatMap((rid) => [userId, rid, assignedBy]),
    )
  }
}

/** The users (login accounts) that hold a role, for the assignment UI. */
export async function getRoleMembers(tenantId: number, roleId: number): Promise<number[]> {
  await ensureRoleSchema()
  const owned = await query<{ id: number }[]>(
    `SELECT id FROM custom_roles WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, roleId],
  )
  if (owned.length === 0) return []
  const rows = await query<{ user_id: number }[]>(
    `SELECT user_id FROM user_custom_roles WHERE role_id = ?`,
    [roleId],
  )
  return rows.map((r) => r.user_id)
}

/**
 * The merged, most-permissive matrix from EVERY role a user holds, or null when
 * the user holds no roles. Consumed by lib/permission-store.ts to build the
 * effective matrix enforcement reads.
 */
export async function getUserRolesMatrix(tenantId: number, userId: number): Promise<PermissionMatrix | null> {
  await ensureRoleSchema()
  const rows = await query<
    {
      module_key: string
      can_add: PermissionScope
      can_view: PermissionScope
      can_update: PermissionScope
      can_delete: PermissionScope
    }[]
  >(
    `SELECT rmp.module_key, rmp.can_add, rmp.can_view, rmp.can_update, rmp.can_delete
       FROM user_custom_roles ucr
       JOIN custom_roles r ON r.id = ucr.role_id AND r.tenant_id = ?
       JOIN role_module_permissions rmp ON rmp.role_id = ucr.role_id
      WHERE ucr.user_id = ?`,
    [tenantId, userId],
  )
  const actionRows = await query<{ module_key: string; action_key: string; scope: PermissionScope }[]>(
    `SELECT rmap.module_key, rmap.action_key, rmap.scope
       FROM user_custom_roles ucr
       JOIN custom_roles r ON r.id = ucr.role_id AND r.tenant_id = ?
       JOIN role_module_action_permissions rmap ON rmap.role_id = ucr.role_id
      WHERE ucr.user_id = ?`,
    [tenantId, userId],
  )
  if (rows.length === 0 && actionRows.length === 0) return null

  // Build a per-row matrix then merge so duplicate module rows across roles
  // combine most-permissively.
  const perRow: PermissionMatrix[] = rows.map((r) => ({
    [r.module_key]: { add: r.can_add, view: r.can_view, update: r.can_update, delete: r.can_delete },
  }))
  for (const r of actionRows) {
    perRow.push({
      [r.module_key]: { add: "none", view: "none", update: "none", delete: "none", extra: { [r.action_key]: r.scope } },
    })
  }
  return mergeMatrices(perRow)
}
