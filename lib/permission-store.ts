import { query } from "./db"
import {
  PERMISSION_MODULES,
  getExtendedAction,
  getPermissionModule,
  mergeMatrices,
  type PermissionAction,
  type PermissionMatrix,
  type PermissionScope,
} from "./permission-model"
import { getCurrentTenant } from "./tenant-context"
import { cachedForTenant, invalidateTargetForAllTenants } from "./tenant-cache"

let schemaEnsured = false

/**
 * Self-healing schema: creates the `user_module_permissions` table and adds
 * the `hr_employees.user_id` link column if they don't exist yet, so the
 * Worksuite-style permission structure works even before the SQL migration
 * is run manually. Short-circuits after the first successful call.
 */
export async function ensurePermissionSchema() {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS user_module_permissions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      can_add ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      can_view ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      can_update ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      can_delete ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      granted_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_module (user_id, module_key),
      KEY idx_ump_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Phase 44 — module-specific extended action grants (e.g. GST file/amend/
  // reopen). Kept in a SEPARATE table so the base CRUD matrix table is never
  // altered and existing behaviour is untouched when no extended grants exist.
  await query(
    `CREATE TABLE IF NOT EXISTS user_module_action_permissions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      action_key VARCHAR(60) NOT NULL,
      scope ENUM('none','all','added','owned','both') NOT NULL DEFAULT 'none',
      granted_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_module_action (user_id, module_key, action_key),
      KEY idx_umap_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Add hr_employees.user_id (link to a login account) if missing.
  const cols = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'user_id'`,
  )
  if (cols[0]?.c === 0) {
    await query(`ALTER TABLE hr_employees ADD COLUMN user_id INT UNSIGNED NULL AFTER employee_id`)
    // Best-effort index; ignore if it already exists.
    await query(`ALTER TABLE hr_employees ADD KEY idx_hr_employees_user (user_id)`).catch(() => {})
  }

  schemaEnsured = true
}

type Row = {
  module_key: string
  can_add: PermissionScope
  can_view: PermissionScope
  can_update: PermissionScope
  can_delete: PermissionScope
}

/**
 * The saved matrix for a user, or `null` when the user has never had a matrix
 * configured (so callers can fall back to the legacy feature grants).
 */
export async function getUserMatrix(userId: number): Promise<PermissionMatrix | null> {
  await ensurePermissionSchema()
  const rows = await query<Row[]>(
    `SELECT module_key, can_add, can_view, can_update, can_delete
     FROM user_module_permissions WHERE user_id = ?`,
    [userId],
  )
  if (rows.length === 0) return null
  const matrix: PermissionMatrix = {}
  for (const r of rows) {
    matrix[r.module_key] = {
      add: r.can_add,
      view: r.can_view,
      update: r.can_update,
      delete: r.can_delete,
    }
  }

  // Overlay module-specific extended-action grants (Phase 44).
  const actionRows = await query<{ module_key: string; action_key: string; scope: PermissionScope }[]>(
    `SELECT module_key, action_key, scope FROM user_module_action_permissions WHERE user_id = ?`,
    [userId],
  )
  for (const r of actionRows) {
    if (!matrix[r.module_key]) {
      matrix[r.module_key] = { add: "none", view: "none", update: "none", delete: "none" }
    }
    const mod = matrix[r.module_key]
    if (!mod.extra) mod.extra = {}
    mod.extra[r.action_key] = r.scope
  }

  return matrix
}

/**
 * SPEC 8 — the EFFECTIVE matrix enforcement reads: the most-permissive union
 * of every custom role the user holds PLUS their per-user override matrix.
 *
 * Backward compatible: a user with only a personal matrix resolves to exactly
 * that matrix; a user with neither a role nor a personal matrix resolves to
 * `null`, preserving the legacy "no matrix at all → full access / legacy
 * feature grants" fallback in getScope / permissions.ts.
 *
 * Roles are tenant-scoped, so this needs the acting tenant. When there is no
 * tenant in context (system/pre-auth paths) it falls back to the personal
 * matrix alone — role composition simply doesn't apply there.
 */
export async function getEffectiveUserMatrix(userId: number): Promise<PermissionMatrix | null> {
  const tenant = getCurrentTenant()
  if (!tenant) {
    // No tenant in context: role composition (which IS tenant-scoped) does not
    // apply, and there is no safe tenant key to cache under, so read straight
    // through to the personal matrix.
    return getUserMatrix(userId)
  }

  // SPEC 80 — the effective matrix is read on every permission check (sidebar
  // build, record scoping, API authorization). Cache it keyed by the OWNING
  // tenant so tenant A can never be served a matrix resolved for tenant B; the
  // userId is part of the subkey so users never collide either. Permission
  // writes evict the whole target (see setUserMatrix / role-store), and the
  // short TTL is the backstop for anything not explicitly invalidated.
  return cachedForTenant<PermissionMatrix | null>(
    "permissions",
    tenant.tenantId,
    `matrix:u:${userId}`,
    async () => {
      const personal = await getUserMatrix(userId)
      // Lazy import avoids a static import cycle (role-store → permission-model,
      // permission-store → role-store) and keeps role-store out of code paths
      // that never touch roles.
      const { getUserRolesMatrix } = await import("./role-store")
      const rolesMatrix = await getUserRolesMatrix(tenant.tenantId, userId).catch(() => null)
      if (!rolesMatrix) return personal
      return mergeMatrices([rolesMatrix, personal])
    },
  )
}

/** Replace a user's entire permission matrix. */
export async function setUserMatrix(userId: number, matrix: PermissionMatrix, grantedBy: number) {
  await ensurePermissionSchema()
  const valid = new Set(["none", "all", "added", "owned", "both"])
  const rows: [number, string, string, string, string, string, number][] = []
  for (const mod of PERMISSION_MODULES) {
    const p = matrix[mod.key]
    if (!p) continue
    const clamp = (v: string) => (valid.has(v) ? v : "none")
    rows.push([userId, mod.key, clamp(p.add), clamp(p.view), clamp(p.update), clamp(p.delete), grantedBy])
  }
  await query("DELETE FROM user_module_permissions WHERE user_id = ?", [userId])
  if (rows.length > 0) {
    await query(
      `INSERT INTO user_module_permissions
         (user_id, module_key, can_add, can_view, can_update, can_delete, granted_by)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      rows.flat(),
    )
  }

  // Persist extended-action grants — only for actions actually declared on a
  // module, so unknown keys from the client are ignored.
  const actionRows: [number, string, string, string, number][] = []
  for (const mod of PERMISSION_MODULES) {
    const p = matrix[mod.key]
    if (!p?.extra || !mod.extraActions) continue
    for (const ext of mod.extraActions) {
      const v = p.extra[ext.key]
      if (v === undefined) continue
      actionRows.push([userId, mod.key, ext.key, valid.has(v) ? v : "none", grantedBy])
    }
  }
  await query("DELETE FROM user_module_action_permissions WHERE user_id = ?", [userId])
  if (actionRows.length > 0) {
    await query(
      `INSERT INTO user_module_action_permissions
         (user_id, module_key, action_key, scope, granted_by)
       VALUES ${actionRows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      actionRows.flat(),
    )
  }

  // SPEC 80 — a personal matrix feeds the effective matrix in every tenant the
  // user belongs to, and this path has no single tenant id to scope by, so drop
  // the whole permissions cache. Permission writes are rare; correctness wins.
  invalidateTargetForAllTenants("permissions")
}

/**
 * The effective scope for a user on a module/action.
 *
 * The matrix is enforced for EVERY role, admins included — an admin who has a
 * permission matrix configured is scoped by it exactly like an employee. Only
 * when a user (of any role) has NO configured matrix at all do we fall back to
 * "all", so accounts that were never given an explicit matrix keep working and
 * record-level scoping stays a no-op for them (page/menu visibility is still
 * governed by the legacy feature grants).
 */
export async function getScope(
  userId: number,
  role: "admin" | "employee",
  moduleKey: string,
  action: PermissionAction,
): Promise<PermissionScope> {
  const matrix = await getEffectiveUserMatrix(userId)
  if (!matrix) return "all"
  return matrix[moduleKey]?.[action] ?? "none"
}

/**
 * Effective scope for a module-specific EXTENDED action (Phase 44), e.g. GST
 * "file_return" / "amend_return". Mirrors `getScope`:
 *   - No configured matrix at all  -> "all" (admins / legacy accounts keep
 *     working exactly as before).
 *   - Explicit extended grant set   -> that value wins.
 *   - Matrix configured but the extended action was never set -> DERIVE from
 *     the action's declared base-CRUD `fallback` (destructive actions fall
 *     back to `delete`, so a mere Update never implies File/Pay/Reopen/Amend).
 *   - Unknown action                -> "none".
 */
export async function getActionScope(
  userId: number,
  _role: "admin" | "employee",
  moduleKey: string,
  actionKey: string,
): Promise<PermissionScope> {
  const matrix = await getEffectiveUserMatrix(userId)
  if (!matrix) return "all"
  const modPerm = matrix[moduleKey]
  const explicit = modPerm?.extra?.[actionKey]
  if (explicit !== undefined) return explicit
  const ext = getExtendedAction(moduleKey, actionKey)
  if (!ext) return "none"
  return modPerm?.[ext.fallback] ?? "none"
}

/**
 * Whether a user is granted a module-specific extended action. GST returns are
 * period-level org documents with no per-user owner, so any non-"none" scope
 * means granted; "none" means denied.
 */
export async function hasActionGrant(
  userId: number,
  role: "admin" | "employee",
  moduleKey: string,
  actionKey: string,
): Promise<boolean> {
  const scope = await getActionScope(userId, role, moduleKey, actionKey)
  return scope !== "none"
}

/**
 * Build a SQL WHERE fragment (and params) enforcing a record-level scope.
 * `alias` is the table alias/qualifier (e.g. "l" or "sales_leads"); omit for
 * an unaliased table. Returns `1=1` for full access and `1=0` for no access.
 */
export function scopeWhere(
  scope: PermissionScope,
  moduleKey: string,
  userId: number,
  alias?: string,
): { sql: string; params: number[] } {
  const q = alias ? `${alias}.` : ""
  const cfg = getPermissionModule(moduleKey)?.scope
  const added = cfg?.addedBy ? `${q}${cfg.addedBy}` : null
  const owned = cfg?.ownedBy ? `${q}${cfg.ownedBy}` : null

  switch (scope) {
    case "all":
      return { sql: "1=1", params: [] }
    case "none":
      return { sql: "1=0", params: [] }
    case "added":
      return added ? { sql: `${added} = ?`, params: [userId] } : { sql: "1=0", params: [] }
    case "owned":
      return owned ? { sql: `${owned} = ?`, params: [userId] } : { sql: "1=0", params: [] }
    case "both": {
      const parts: string[] = []
      const params: number[] = []
      if (added) {
        parts.push(`${added} = ?`)
        params.push(userId)
      }
      if (owned) {
        parts.push(`${owned} = ?`)
        params.push(userId)
      }
      return parts.length ? { sql: `(${parts.join(" OR ")})`, params } : { sql: "1=0", params: [] }
    }
    default:
      return { sql: "1=0", params: [] }
  }
}

/**
 * Convenience: fetch the scope AND its WHERE fragment in one call, for use in
 * list/detail queries.
 */
export async function scopeFilter(
  userId: number,
  role: "admin" | "employee",
  moduleKey: string,
  action: PermissionAction,
  alias?: string,
): Promise<{ scope: PermissionScope; sql: string; params: number[] }> {
  const scope = await getScope(userId, role, moduleKey, action)
  const { sql, params } = scopeWhere(scope, moduleKey, userId, alias)
  return { scope, sql, params }
}
