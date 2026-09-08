import { query } from "./db"
import {
  PERMISSION_MODULES,
  getPermissionModule,
  type PermissionAction,
  type PermissionMatrix,
  type PermissionScope,
} from "./permission-model"

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
  return matrix
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
  if (rows.length === 0) return
  await query(
    `INSERT INTO user_module_permissions
       (user_id, module_key, can_add, can_view, can_update, can_delete, granted_by)
     VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
    rows.flat(),
  )
}

/**
 * The effective scope for a user on a module/action.
 * Admins always get "all". If the user has no configured matrix, returns
 * "all" so record-level scoping is a no-op until an admin sets permissions
 * (module/page visibility is still governed by the legacy feature grants).
 */
export async function getScope(
  userId: number,
  role: "admin" | "employee",
  moduleKey: string,
  action: PermissionAction,
): Promise<PermissionScope> {
  if (role === "admin") return "all"
  const matrix = await getUserMatrix(userId)
  if (!matrix) return "all"
  return matrix[moduleKey]?.[action] ?? "none"
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
