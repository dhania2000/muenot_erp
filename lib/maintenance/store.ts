import "server-only"
/**
 * Spec28 (#125) — Maintenance windows persistence + enforcement lookups.
 *
 * `platform_maintenance_windows` is deliberately NOT in the tenant-owned
 * registry: platform-scope rows have tenant_id NULL and must be visible to every
 * tenant. Tenant isolation is enforced here instead — tenant-facing functions
 * always pin `tenant_id = ?` to the caller's server-derived tenant and never
 * return another tenant's rows.
 */
import { query } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import {
  type MaintenanceWindow,
  type MaintenanceTarget,
  type MaintenanceResolution,
  type WindowInput,
  resolveMaintenance,
  toDbDate,
} from "@/lib/maintenance/model"

export class MaintenanceError extends Error {
  status: number
  code: string
  constructor(message: string, code = "MAINTENANCE_ERROR", status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

let schemaReady: Promise<void> | null = null

export function ensureMaintenanceSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS \`platform_maintenance_windows\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`scope\` VARCHAR(16) NOT NULL,
        \`tenant_id\` INT UNSIGNED DEFAULT NULL,
        \`module_key\` VARCHAR(48) DEFAULT NULL,
        \`title\` VARCHAR(200) NOT NULL,
        \`message\` VARCHAR(1000) NOT NULL DEFAULT '',
        \`starts_at\` DATETIME NOT NULL,
        \`ends_at\` DATETIME DEFAULT NULL,
        \`status\` VARCHAR(16) NOT NULL DEFAULT 'scheduled',
        \`idempotency_scope\` VARCHAR(40) NOT NULL,
        \`idempotency_key\` VARCHAR(100) DEFAULT NULL,
        \`created_by\` INT UNSIGNED DEFAULT NULL,
        \`ended_by\` INT UNSIGNED DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uniq_maint_idem\` (\`idempotency_scope\`, \`idempotency_key\`),
        KEY \`idx_maint_active\` (\`status\`, \`starts_at\`),
        KEY \`idx_maint_tenant\` (\`tenant_id\`, \`status\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null
        throw err
      })
  }
  return schemaReady
}

type Row = {
  id: number
  scope: string
  tenant_id: number | null
  module_key: string | null
  title: string
  message: string
  starts_at: string
  ends_at: string | null
  status: string
  created_at?: string
}

export function mapWindow(r: Row): MaintenanceWindow {
  return {
    id: Number(r.id),
    scope: r.scope as MaintenanceWindow["scope"],
    tenantId: r.tenant_id == null ? null : Number(r.tenant_id),
    moduleKey: r.module_key,
    title: r.title,
    message: r.message,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status as MaintenanceWindow["status"],
  }
}

// Enforcement runs on every workspace render / gated write, so the set of live
// windows is cached briefly per process. Writes invalidate it immediately.
const CACHE_TTL_MS = 15_000
let liveCache: { at: number; rows: MaintenanceWindow[] } | null = null

export function invalidateMaintenanceCache(): void {
  liveCache = null
}

/** Every not-yet-finished window (all scopes). Internal; filter before exposing. */
async function liveWindows(): Promise<MaintenanceWindow[]> {
  if (liveCache && Date.now() - liveCache.at < CACHE_TTL_MS) return liveCache.rows
  await ensureMaintenanceSchema()
  const rows = await query<Row[]>(
    "SELECT * FROM `platform_maintenance_windows` WHERE `status` = 'scheduled' AND (`ends_at` IS NULL OR `ends_at` > UTC_TIMESTAMP()) ORDER BY `starts_at` ASC LIMIT 500",
  )
  const mapped = rows.map(mapWindow)
  liveCache = { at: Date.now(), rows: mapped }
  return mapped
}

/**
 * Resolve maintenance for one tenant/module. Only windows that apply to this
 * tenant (platform, its own, or all-tenant module windows) can influence the
 * result — another tenant's windows are filtered out by resolveMaintenance.
 */
export async function getMaintenanceFor(target: MaintenanceTarget, now = new Date()): Promise<MaintenanceResolution> {
  try {
    return resolveMaintenance(await liveWindows(), target, now)
  } catch {
    // Fail OPEN: a maintenance-lookup failure must never lock every tenant out.
    return { active: null, activeModules: [], upcoming: [] }
  }
}

/** Platform-wide active windows only — safe for the public status page. */
export async function getActivePlatformWindows(now = new Date()): Promise<MaintenanceWindow[]> {
  const res = await getMaintenanceFor({ tenantId: null }, now)
  return [res.active, ...res.upcoming].filter((w): w is MaintenanceWindow => !!w && w.scope === "platform")
}

export async function listAllWindows(limit = 200): Promise<MaintenanceWindow[]> {
  await ensureMaintenanceSchema()
  const rows = await query<Row[]>(
    "SELECT * FROM `platform_maintenance_windows` ORDER BY `starts_at` DESC LIMIT ?",
    [Math.max(1, Math.min(500, limit))],
  )
  return rows.map(mapWindow)
}

/** A tenant's own windows (tenant + tenant-module scope). Never other tenants'. */
export async function listTenantWindows(tenantId: number, limit = 100): Promise<MaintenanceWindow[]> {
  await ensureMaintenanceSchema()
  const rows = await query<Row[]>(
    "SELECT * FROM `platform_maintenance_windows` WHERE `tenant_id` = ? ORDER BY `starts_at` DESC LIMIT ?",
    [tenantId, Math.max(1, Math.min(200, limit))],
  )
  return rows.map(mapWindow)
}

export type Actor = { userId: number }

/**
 * Create a window. Idempotent per (scope-owner, Idempotency-Key): a retried
 * request returns the originally created window instead of a duplicate.
 */
export async function createWindow(
  input: WindowInput,
  actor: Actor,
  idempotencyKey: string | null,
): Promise<{ window: MaintenanceWindow; replayed: boolean }> {
  await ensureMaintenanceSchema()
  const idemScope = input.tenantId == null ? "platform" : `tenant:${input.tenantId}`
  if (idempotencyKey) {
    const prior = await query<Row[]>(
      "SELECT * FROM `platform_maintenance_windows` WHERE `idempotency_scope` = ? AND `idempotency_key` = ? LIMIT 1",
      [idemScope, idempotencyKey],
    )
    if (prior[0]) return { window: mapWindow(prior[0]), replayed: true }
  }
  let insertId: number
  try {
    const res = await query<any>(
      `INSERT INTO \`platform_maintenance_windows\`
         (\`scope\`, \`tenant_id\`, \`module_key\`, \`title\`, \`message\`, \`starts_at\`, \`ends_at\`, \`status\`, \`idempotency_scope\`, \`idempotency_key\`, \`created_by\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
      [
        input.scope,
        input.tenantId,
        input.moduleKey,
        input.title,
        input.message,
        toDbDate(input.startsAt),
        input.endsAt ? toDbDate(input.endsAt) : null,
        idemScope,
        idempotencyKey,
        actor.userId,
      ],
    )
    insertId = Number(res?.insertId)
  } catch (err: any) {
    // Concurrent retry won the race on the unique key → replay it.
    if (err?.code === "ER_DUP_ENTRY" && idempotencyKey) {
      const prior = await query<Row[]>(
        "SELECT * FROM `platform_maintenance_windows` WHERE `idempotency_scope` = ? AND `idempotency_key` = ? LIMIT 1",
        [idemScope, idempotencyKey],
      )
      if (prior[0]) return { window: mapWindow(prior[0]), replayed: true }
    }
    throw err
  }
  invalidateMaintenanceCache()
  const rows = await query<Row[]>("SELECT * FROM `platform_maintenance_windows` WHERE `id` = ? LIMIT 1", [insertId])
  const window = mapWindow(rows[0])
  await recordAuditLog({
    action: "maintenance.window_create",
    entityType: "maintenance_window",
    entityId: String(window.id),
    entityLabel: window.title,
    result: "success",
    after: { scope: window.scope, tenantId: window.tenantId, moduleKey: window.moduleKey, startsAt: window.startsAt, endsAt: window.endsAt },
  }).catch(() => {})
  return { window, replayed: false }
}

export async function getWindow(id: number): Promise<MaintenanceWindow | null> {
  await ensureMaintenanceSchema()
  const rows = await query<Row[]>("SELECT * FROM `platform_maintenance_windows` WHERE `id` = ? LIMIT 1", [id])
  return rows[0] ? mapWindow(rows[0]) : null
}

/**
 * End a window early ("complete") or call it off ("cancel"). When
 * `requireTenantId` is given the window must belong to that tenant — a tenant
 * admin can never end platform or another tenant's maintenance (404, no leak).
 * Idempotent: ending an already-ended window is a no-op success.
 */
export async function endWindow(
  id: number,
  action: "complete" | "cancel",
  actor: Actor,
  requireTenantId?: number,
): Promise<MaintenanceWindow> {
  const w = await getWindow(id)
  if (!w || (requireTenantId != null && w.tenantId !== requireTenantId)) {
    throw new MaintenanceError("Maintenance window not found", "NOT_FOUND", 404)
  }
  if (w.status !== "scheduled") return w
  const status = action === "complete" ? "completed" : "cancelled"
  await query(
    `UPDATE \`platform_maintenance_windows\`
        SET \`status\` = ?, \`ended_by\` = ?,
            \`ends_at\` = CASE WHEN ? = 'completed' AND (\`ends_at\` IS NULL OR \`ends_at\` > UTC_TIMESTAMP()) THEN UTC_TIMESTAMP() ELSE \`ends_at\` END
      WHERE \`id\` = ? AND \`status\` = 'scheduled'`,
    [status, actor.userId, status, id],
  )
  invalidateMaintenanceCache()
  await recordAuditLog({
    action: `maintenance.window_${action}`,
    entityType: "maintenance_window",
    entityId: String(id),
    entityLabel: w.title,
    result: "success",
    before: { status: w.status },
    after: { status },
  }).catch(() => {})
  return (await getWindow(id)) ?? w
}
