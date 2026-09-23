import "server-only"
/**
 * SPEC 83 — Enterprise Dashboard Engine: saved-dashboard persistence.
 *
 * Dashboards are tenant-scoped and come in three scopes:
 *   - personal : owned by a single user (owner_user_id)
 *   - role     : shared with everyone holding a role key (role_key)
 *   - tenant   : shared with the whole tenant
 *
 * Only tenant admins/owners (or the legacy `admin` role) may create or edit
 * role/tenant dashboards; anyone may manage their own personal dashboards.
 * A runtime `ensureSchema` self-heals the table so installs converge without a
 * manual migration step (same pattern used across this codebase).
 */
import { query } from "@/lib/db"
import type { DashboardConfig, DashboardRecord, DashboardScope } from "./types"
import { ROLE_KEYS } from "./types"

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`dashboards\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(160) NOT NULL,
      \`scope\` ENUM('personal','role','tenant') NOT NULL DEFAULT 'personal',
      \`owner_user_id\` INT UNSIGNED DEFAULT NULL,
      \`role_key\` VARCHAR(64) DEFAULT NULL,
      \`config\` JSON NOT NULL,
      \`is_default\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_dashboards_tenant_scope\` (\`tenant_id\`, \`scope\`),
      KEY \`idx_dashboards_owner\` (\`tenant_id\`, \`owner_user_id\`),
      KEY \`idx_dashboards_role\` (\`tenant_id\`, \`role_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureDashboardSchema(): Promise<void> {
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
}

/** Tenant admins/owners (or legacy admins) may manage shared dashboards. */
export function canManageShared(viewer: Viewer): boolean {
  return viewer.role === "admin" || viewer.tenantRole === "tenant_admin" || viewer.tenantRole === "tenant_owner"
}

function parseConfig(raw: unknown): DashboardConfig {
  let obj: any = raw
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw)
    } catch {
      obj = {}
    }
  }
  const widgets = Array.isArray(obj?.widgets)
    ? obj.widgets
        .filter((w: any) => w && typeof w.key === "string")
        .map((w: any) => ({ id: String(w.id ?? w.key), key: String(w.key) }))
    : []
  const f = obj?.filters ?? {}
  return {
    widgets,
    filters: {
      preset: typeof f.preset === "string" ? f.preset : "last_30",
      from: typeof f.from === "string" ? f.from : null,
      to: typeof f.to === "string" ? f.to : null,
      department: typeof f.department === "string" ? f.department : null,
      modules: Array.isArray(f.modules) ? f.modules.filter((m: any) => typeof m === "string") : null,
    },
  }
}

function rowToRecord(row: any, viewer: Viewer): DashboardRecord {
  const scope = row.scope as DashboardScope
  const ownerUserId = row.owner_user_id != null ? Number(row.owner_user_id) : null
  const canEdit =
    scope === "personal" ? ownerUserId === viewer.userId : canManageShared(viewer)
  return {
    id: Number(row.id),
    name: row.name ?? "Untitled",
    scope,
    roleKey: row.role_key ?? null,
    ownerUserId,
    isDefault: Boolean(row.is_default),
    config: parseConfig(row.config),
    canEdit,
  }
}

/** Dashboards visible to the viewer: own personal + matching role + tenant-wide. */
export async function listDashboards(viewer: Viewer): Promise<DashboardRecord[]> {
  await ensureDashboardSchema()
  const roleKeys = Array.from(viewer.roleKeys).filter(Boolean)
  const rolePlaceholders = roleKeys.length ? roleKeys.map(() => "?").join(",") : "NULL"
  const data = await query<any[]>(
    `SELECT * FROM \`dashboards\`
      WHERE tenant_id = ?
        AND (
          (scope = 'personal' AND owner_user_id = ?)
          OR (scope = 'role' AND role_key IN (${rolePlaceholders}))
          OR (scope = 'tenant')
        )
      ORDER BY FIELD(scope,'personal','role','tenant'), is_default DESC, name ASC`,
    [viewer.tenantId, viewer.userId, ...roleKeys],
  )
  return data.map((r) => rowToRecord(r, viewer))
}

export async function getDashboard(viewer: Viewer, id: number): Promise<DashboardRecord | null> {
  await ensureDashboardSchema()
  const [row] = await query<any[]>(`SELECT * FROM \`dashboards\` WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    viewer.tenantId,
  ])
  if (!row) return null
  return rowToRecord(row, viewer)
}

export type SaveInput = {
  name: string
  scope: DashboardScope
  roleKey: string | null
  config: DashboardConfig
}

export class DashboardError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function assertScopeAllowed(viewer: Viewer, scope: DashboardScope, roleKey: string | null): void {
  if (scope === "personal") return
  if (!canManageShared(viewer)) {
    throw new DashboardError("You are not permitted to create shared dashboards", 403)
  }
  if (scope === "role" && (!roleKey || !ROLE_KEYS.includes(roleKey as any))) {
    throw new DashboardError("A valid role is required for a role dashboard", 400)
  }
}

export async function createDashboard(viewer: Viewer, input: SaveInput): Promise<number> {
  await ensureDashboardSchema()
  assertScopeAllowed(viewer, input.scope, input.roleKey)
  const name = input.name.trim().slice(0, 160) || "Untitled dashboard"
  const res = await query<any>(
    `INSERT INTO \`dashboards\` (tenant_id, name, scope, owner_user_id, role_key, config, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      viewer.tenantId,
      name,
      input.scope,
      input.scope === "personal" ? viewer.userId : null,
      input.scope === "role" ? input.roleKey : null,
      JSON.stringify(input.config),
      viewer.userId,
    ],
  )
  return Number(res?.insertId ?? 0)
}

export async function updateDashboard(viewer: Viewer, id: number, input: SaveInput): Promise<void> {
  const existing = await getDashboard(viewer, id)
  if (!existing) throw new DashboardError("Dashboard not found", 404)
  if (!existing.canEdit) throw new DashboardError("You cannot edit this dashboard", 403)
  assertScopeAllowed(viewer, input.scope, input.roleKey)
  const name = input.name.trim().slice(0, 160) || existing.name
  await query(
    `UPDATE \`dashboards\`
        SET name = ?, scope = ?, owner_user_id = ?, role_key = ?, config = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      name,
      input.scope,
      input.scope === "personal" ? viewer.userId : null,
      input.scope === "role" ? input.roleKey : null,
      JSON.stringify(input.config),
      id,
      viewer.tenantId,
    ],
  )
}

export async function deleteDashboard(viewer: Viewer, id: number): Promise<void> {
  const existing = await getDashboard(viewer, id)
  if (!existing) throw new DashboardError("Dashboard not found", 404)
  if (!existing.canEdit) throw new DashboardError("You cannot delete this dashboard", 403)
  await query(`DELETE FROM \`dashboards\` WHERE id = ? AND tenant_id = ?`, [id, viewer.tenantId])
}

/** Distinct department names for the HR department filter. */
export async function getDepartments(): Promise<string[]> {
  try {
    const data = await query<any[]>(
      `SELECT DISTINCT department FROM hr_employees
        WHERE department IS NOT NULL AND department <> '' ORDER BY department LIMIT 100`,
    )
    return data.map((r) => String(r.department))
  } catch {
    return []
  }
}
