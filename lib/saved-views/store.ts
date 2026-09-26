import "server-only"
/**
 * Saved Views: persistence.
 *
 * Views are tenant-scoped and belong to a single table (`table_key`). Their
 * visibility controls who else can see them:
 *   - private : only the owner (owner_user_id)
 *   - public  : the whole tenant
 *   - role    : everyone holding a role key (role_key)
 *   - team    : everyone in a team / department (team_key)
 *
 * Only tenant admins/owners (or the legacy `admin` role) may create or edit
 * public/role views. Team views may be created by any member of that team, and
 * edited by their creator (or a shared-view manager). A runtime `ensureSchema`
 * self-heals the table so installs converge without a manual migration step —
 * the same pattern 's dashboard store uses.
 */
import { query } from "@/lib/db"
import type { SavedViewRecord, TableViewConfig, ViewVisibility } from "./types"
import { ROLE_KEYS } from "./types"
import { sanitizeViewConfig } from "./sanitize"

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`saved_views\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`table_key\` VARCHAR(96) NOT NULL,
      \`name\` VARCHAR(160) NOT NULL,
      \`visibility\` ENUM('private','public','role','team') NOT NULL DEFAULT 'private',
      \`owner_user_id\` INT UNSIGNED DEFAULT NULL,
      \`role_key\` VARCHAR(64) DEFAULT NULL,
      \`team_key\` VARCHAR(128) DEFAULT NULL,
      \`config\` JSON NOT NULL,
      \`is_default\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_saved_views_tenant_table\` (\`tenant_id\`, \`table_key\`),
      KEY \`idx_saved_views_owner\` (\`tenant_id\`, \`owner_user_id\`),
      KEY \`idx_saved_views_role\` (\`tenant_id\`, \`role_key\`),
      KEY \`idx_saved_views_team\` (\`tenant_id\`, \`team_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureSavedViewSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

export type Viewer = {
  userId: number
  tenantId: number
  role: "admin" | "employee"
  tenantRole: string
  roleKeys: Set<string>
  teamKeys: Set<string>
}

/** Tenant admins/owners (or legacy admins) may manage public/role views. */
export function canManageShared(viewer: Viewer): boolean {
  return viewer.role === "admin" || viewer.tenantRole === "tenant_admin" || viewer.tenantRole === "tenant_owner"
}

/**
 * Resolve the teams (departments) a user belongs to, so team-shared views can
 * be listed and gated. Degrades to an empty set when the HR table or columns
 * are absent rather than throwing.
 */
export async function resolveTeamKeys(tenantId: number, userId: number): Promise<Set<string>> {
  try {
    const rows = await query<any[]>(
      `SELECT DISTINCT department FROM hr_employees
        WHERE user_id = ? AND department IS NOT NULL AND department <> '' LIMIT 50`,
      [userId],
    )
    void tenantId
    return new Set(rows.map((r) => String(r.department)))
  } catch {
    return new Set<string>()
  }
}

/** Parse the stored JSON config through the shared sanitizer (see sanitize.ts). */
function parseConfig(raw: unknown): TableViewConfig {
  return sanitizeViewConfig(raw)
}

function rowToRecord(row: any, viewer: Viewer): SavedViewRecord {
  const visibility = row.visibility as ViewVisibility
  const ownerUserId = row.owner_user_id != null ? Number(row.owner_user_id) : null
  const createdBy = row.created_by != null ? Number(row.created_by) : null
  let canEdit = false
  if (visibility === "private") canEdit = ownerUserId === viewer.userId
  else if (visibility === "team") canEdit = createdBy === viewer.userId || canManageShared(viewer)
  else canEdit = canManageShared(viewer)
  return {
    id: Number(row.id),
    tableKey: String(row.table_key),
    name: row.name ?? "Untitled view",
    visibility,
    roleKey: row.role_key ?? null,
    teamKey: row.team_key ?? null,
    ownerUserId,
    isDefault: Boolean(row.is_default),
    config: parseConfig(row.config),
    canEdit,
  }
}

/** Views visible to the viewer for a given table. */
export async function listViews(viewer: Viewer, tableKey: string): Promise<SavedViewRecord[]> {
  await ensureSavedViewSchema()
  const roleKeys = Array.from(viewer.roleKeys).filter(Boolean)
  const teamKeys = Array.from(viewer.teamKeys).filter(Boolean)
  const rolePlaceholders = roleKeys.length ? roleKeys.map(() => "?").join(",") : "NULL"
  const teamPlaceholders = teamKeys.length ? teamKeys.map(() => "?").join(",") : "NULL"
  const data = await query<any[]>(
    `SELECT * FROM \`saved_views\`
      WHERE tenant_id = ? AND table_key = ?
        AND (
          (visibility = 'private' AND owner_user_id = ?)
          OR (visibility = 'public')
          OR (visibility = 'role' AND role_key IN (${rolePlaceholders}))
          OR (visibility = 'team' AND team_key IN (${teamPlaceholders}))
        )
      ORDER BY FIELD(visibility,'private','team','role','public'), is_default DESC, name ASC`,
    [viewer.tenantId, tableKey, viewer.userId, ...roleKeys, ...teamKeys],
  )
  return data.map((r) => rowToRecord(r, viewer))
}

export async function getView(viewer: Viewer, id: number): Promise<SavedViewRecord | null> {
  await ensureSavedViewSchema()
  const [row] = await query<any[]>(`SELECT * FROM \`saved_views\` WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    viewer.tenantId,
  ])
  if (!row) return null
  return rowToRecord(row, viewer)
}

export type SaveInput = {
  tableKey: string
  name: string
  visibility: ViewVisibility
  roleKey: string | null
  teamKey: string | null
  config: TableViewConfig
  isDefault: boolean
}

export class SavedViewError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function assertVisibilityAllowed(viewer: Viewer, visibility: ViewVisibility, roleKey: string | null, teamKey: string | null): void {
  if (visibility === "private") return
  if (visibility === "team") {
    if (!teamKey) throw new SavedViewError("A team is required for a team view", 400)
    if (!viewer.teamKeys.has(teamKey) && !canManageShared(viewer)) {
      throw new SavedViewError("You can only share views with a team you belong to", 403)
    }
    return
  }
  // public + role require shared-view management rights.
  if (!canManageShared(viewer)) {
    throw new SavedViewError("You are not permitted to create shared views", 403)
  }
  if (visibility === "role" && (!roleKey || !ROLE_KEYS.includes(roleKey as any))) {
    throw new SavedViewError("A valid role is required for a role view", 400)
  }
}

/** Clear other defaults for the same (tenant, table, audience) so one wins. */
async function clearSiblingDefaults(viewer: Viewer, input: SaveInput, exceptId: number | null): Promise<void> {
  const params: any[] = [viewer.tenantId, input.tableKey]
  let audience = ""
  if (input.visibility === "private") {
    audience = "AND visibility = 'private' AND owner_user_id = ?"
    params.push(viewer.userId)
  } else if (input.visibility === "public") {
    audience = "AND visibility = 'public'"
  } else if (input.visibility === "role") {
    audience = "AND visibility = 'role' AND role_key = ?"
    params.push(input.roleKey)
  } else {
    audience = "AND visibility = 'team' AND team_key = ?"
    params.push(input.teamKey)
  }
  let sql = `UPDATE \`saved_views\` SET is_default = 0 WHERE tenant_id = ? AND table_key = ? ${audience}`
  if (exceptId != null) {
    sql += " AND id <> ?"
    params.push(exceptId)
  }
  await query(sql, params)
}

export async function createView(viewer: Viewer, input: SaveInput): Promise<number> {
  await ensureSavedViewSchema()
  assertVisibilityAllowed(viewer, input.visibility, input.roleKey, input.teamKey)
  const name = input.name.trim().slice(0, 160) || "Untitled view"
  const res = await query<any>(
    `INSERT INTO \`saved_views\`
       (tenant_id, table_key, name, visibility, owner_user_id, role_key, team_key, config, is_default, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      viewer.tenantId,
      input.tableKey.slice(0, 96),
      name,
      input.visibility,
      input.visibility === "private" ? viewer.userId : null,
      input.visibility === "role" ? input.roleKey : null,
      input.visibility === "team" ? input.teamKey : null,
      JSON.stringify(input.config ?? {}),
      input.isDefault ? 1 : 0,
      viewer.userId,
    ],
  )
  const id = Number(res?.insertId ?? 0)
  if (input.isDefault) await clearSiblingDefaults(viewer, input, id)
  return id
}

export async function updateView(viewer: Viewer, id: number, input: SaveInput): Promise<void> {
  const existing = await getView(viewer, id)
  if (!existing) throw new SavedViewError("View not found", 404)
  if (!existing.canEdit) throw new SavedViewError("You cannot edit this view", 403)
  assertVisibilityAllowed(viewer, input.visibility, input.roleKey, input.teamKey)
  const name = input.name.trim().slice(0, 160) || existing.name
  await query(
    `UPDATE \`saved_views\`
        SET name = ?, visibility = ?, owner_user_id = ?, role_key = ?, team_key = ?, config = ?, is_default = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      name,
      input.visibility,
      input.visibility === "private" ? viewer.userId : null,
      input.visibility === "role" ? input.roleKey : null,
      input.visibility === "team" ? input.teamKey : null,
      JSON.stringify(input.config ?? {}),
      input.isDefault ? 1 : 0,
      id,
      viewer.tenantId,
    ],
  )
  if (input.isDefault) await clearSiblingDefaults(viewer, input, id)
}

export async function deleteView(viewer: Viewer, id: number): Promise<void> {
  const existing = await getView(viewer, id)
  if (!existing) throw new SavedViewError("View not found", 404)
  if (!existing.canEdit) throw new SavedViewError("You cannot delete this view", 403)
  await query(`DELETE FROM \`saved_views\` WHERE id = ? AND tenant_id = ?`, [id, viewer.tenantId])
}
