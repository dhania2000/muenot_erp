import "server-only"

/**
 * Spec32 (#176-179) — Versioned product updates / release notes persistence.
 * ---------------------------------------------------------------------------
 * Authoring is a platform-operator concern (the route enforces that). Viewing
 * and read state belong to every signed-in user, scoped to their acting tenant.
 *
 * Audience targeting is stored as JSON and resolved server-side against the
 * viewer (tenant/role/plan) with `isUpdateVisibleTo`, so a tenant-scoped update
 * never leaks to another tenant. Read state rows carry an explicit tenant_id
 * and user_id, so a user can only ever read/mark their own tenant's rows.
 */

import { query } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import {
  isUpdateVisibleTo,
  parseAudienceConfig,
  ProductUpdateError,
  type AudienceConfig,
  type AudienceType,
  type UpdateCategory,
  type UpdateInput,
  type UpdateStatus,
  type Viewer,
} from "@/lib/product-updates/model"

const first = <T = any>(rows: any): T | undefined => (Array.isArray(rows) ? rows[0] : undefined)
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0)

let ensured: Promise<void> | null = null
export function ensureProductUpdatesSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

async function runEnsure(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS \`product_updates\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`version\` VARCHAR(40) NOT NULL,
    \`title\` VARCHAR(200) NOT NULL,
    \`body\` TEXT NOT NULL,
    \`category\` VARCHAR(20) NOT NULL DEFAULT 'announcement',
    \`audience_type\` VARCHAR(12) NOT NULL DEFAULT 'all',
    \`audience_config\` JSON DEFAULT NULL,
    \`status\` VARCHAR(12) NOT NULL DEFAULT 'draft',
    \`published_at\` DATETIME DEFAULT NULL,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`created_by_name\` VARCHAR(160) DEFAULT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    KEY \`idx_pu_status_pub\` (\`status\`, \`published_at\`),
    KEY \`idx_pu_version\` (\`version\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`product_update_reads\` (
    \`update_id\` BIGINT UNSIGNED NOT NULL,
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`user_id\` INT UNSIGNED NOT NULL,
    \`read_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`update_id\`, \`user_id\`),
    KEY \`idx_pur_user\` (\`tenant_id\`, \`user_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

export type ProductUpdate = {
  id: number
  version: string
  title: string
  body: string
  category: UpdateCategory
  audienceType: AudienceType
  audienceConfig: AudienceConfig
  status: UpdateStatus
  publishedAt: string | null
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

function toUpdate(row: any): ProductUpdate {
  return {
    id: Number(row.id),
    version: String(row.version),
    title: String(row.title),
    body: String(row.body),
    category: row.category as UpdateCategory,
    audienceType: row.audience_type as AudienceType,
    audienceConfig: parseAudienceConfig(row.audience_config),
    status: row.status as UpdateStatus,
    publishedAt: row.published_at ? String(row.published_at) : null,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdByName: row.created_by_name == null ? null : String(row.created_by_name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

async function getById(id: number): Promise<ProductUpdate | null> {
  const row = first(await query<any[]>("SELECT * FROM product_updates WHERE id = ?", [id]))
  return row ? toUpdate(row) : null
}

// ---------------------------------------------------------------------------
// Authoring (platform operators only — enforced by the route)
// ---------------------------------------------------------------------------
export async function createUpdate(
  actor: { userId: number; name: string },
  input: UpdateInput,
  auditCtx?: AuditContext,
): Promise<ProductUpdate> {
  await ensureProductUpdatesSchema()
  const res: any = await query(
    `INSERT INTO product_updates (version, title, body, category, audience_type, audience_config, status, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [input.version, input.title, input.body, input.category, input.audienceType, JSON.stringify(input.audienceConfig), actor.userId, actor.name],
  )
  const id = num(res?.insertId)
  await recordAuditLog(
    { action: "product_update.created", entityType: "product_update", entityId: String(id), entityLabel: input.title, metadata: { version: input.version, audienceType: input.audienceType } },
    auditCtx,
  )
  const created = await getById(id)
  if (!created) throw new ProductUpdateError("Failed to create update", "CREATE_FAILED", 500)
  return created
}

export async function updateUpdate(
  id: number,
  actor: { userId: number; name: string },
  input: UpdateInput,
  auditCtx?: AuditContext,
): Promise<ProductUpdate> {
  await ensureProductUpdatesSchema()
  const existing = await getById(id)
  if (!existing) throw new ProductUpdateError("Update not found", "NOT_FOUND", 404)
  await query(
    `UPDATE product_updates SET version = ?, title = ?, body = ?, category = ?, audience_type = ?, audience_config = ? WHERE id = ?`,
    [input.version, input.title, input.body, input.category, input.audienceType, JSON.stringify(input.audienceConfig), id],
  )
  await recordAuditLog(
    { action: "product_update.updated", entityType: "product_update", entityId: String(id), entityLabel: input.title },
    auditCtx,
  )
  return (await getById(id))!
}

/** Publish. Idempotent: publishing an already-published update is a no-op. */
export async function publishUpdate(id: number, auditCtx?: AuditContext): Promise<{ changed: boolean; update: ProductUpdate }> {
  await ensureProductUpdatesSchema()
  const existing = await getById(id)
  if (!existing) throw new ProductUpdateError("Update not found", "NOT_FOUND", 404)
  if (existing.status === "published") return { changed: false, update: existing }
  await query("UPDATE product_updates SET status = 'published', published_at = COALESCE(published_at, NOW()) WHERE id = ?", [id])
  await recordAuditLog({ action: "product_update.published", entityType: "product_update", entityId: String(id), entityLabel: existing.title, metadata: { version: existing.version } }, auditCtx)
  return { changed: true, update: (await getById(id))! }
}

export async function setStatus(
  id: number,
  status: "draft" | "archived",
  auditCtx?: AuditContext,
): Promise<{ changed: boolean; update: ProductUpdate }> {
  await ensureProductUpdatesSchema()
  const existing = await getById(id)
  if (!existing) throw new ProductUpdateError("Update not found", "NOT_FOUND", 404)
  if (existing.status === status) return { changed: false, update: existing }
  await query("UPDATE product_updates SET status = ? WHERE id = ?", [status, id])
  await recordAuditLog({ action: `product_update.${status}`, entityType: "product_update", entityId: String(id), entityLabel: existing.title }, auditCtx)
  return { changed: true, update: (await getById(id))! }
}

export async function deleteUpdate(id: number, auditCtx?: AuditContext): Promise<boolean> {
  await ensureProductUpdatesSchema()
  const existing = await getById(id)
  if (!existing) return false
  if (existing.status === "published") throw new ProductUpdateError("Archive a published update instead of deleting it", "PUBLISHED_LOCKED", 409)
  await query("DELETE FROM product_updates WHERE id = ?", [id])
  await query("DELETE FROM product_update_reads WHERE update_id = ?", [id])
  await recordAuditLog({ action: "product_update.deleted", entityType: "product_update", entityId: String(id), entityLabel: existing.title }, auditCtx)
  return true
}

/** All updates for the authoring console, newest first, optional status filter. */
export async function listAll(opts: { status?: UpdateStatus; limit?: number } = {}): Promise<ProductUpdate[]> {
  await ensureProductUpdatesSchema()
  const where: string[] = []
  const params: any[] = []
  if (opts.status) {
    where.push("status = ?")
    params.push(opts.status)
  }
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100))
  const rows = await query<any[]>(
    `SELECT * FROM product_updates ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ${limit}`,
    params,
  )
  return (rows ?? []).map(toUpdate)
}

export type ViewerUpdate = ProductUpdate & { read: boolean }

/**
 * Published updates visible to a viewer, newest first, each annotated with the
 * viewer's read state. Audience is resolved in-process (the published set is
 * small); read state is joined for this exact user only.
 */
export async function listForViewer(viewer: Viewer, userId: number): Promise<{ updates: ViewerUpdate[]; unread: number }> {
  await ensureProductUpdatesSchema()
  const rows = await query<any[]>(
    `SELECT p.*, r.user_id AS read_user
       FROM product_updates p
       LEFT JOIN product_update_reads r ON r.update_id = p.id AND r.user_id = ?
      WHERE p.status = 'published'
      ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
      LIMIT 200`,
    [userId],
  )
  const updates: ViewerUpdate[] = []
  let unread = 0
  for (const row of rows ?? []) {
    const u = toUpdate(row)
    if (!isUpdateVisibleTo(u, viewer)) continue
    const read = row.read_user != null
    if (!read) unread++
    updates.push({ ...u, read })
  }
  return { updates, unread }
}

/**
 * Mark an update read for a user. Enforces visibility: a user can never mark an
 * update they cannot see (prevents cross-tenant / cross-audience probing).
 * Idempotent via the (update_id, user_id) primary key.
 */
export async function markRead(
  updateId: number,
  viewer: Viewer,
  userId: number,
): Promise<{ changed: boolean }> {
  await ensureProductUpdatesSchema()
  if (viewer.tenantId == null) throw new ProductUpdateError("No tenant in context", "NO_TENANT", 400)
  const existing = await getById(updateId)
  if (!existing || !isUpdateVisibleTo(existing, viewer)) throw new ProductUpdateError("Update not found", "NOT_FOUND", 404)
  const res: any = await query(
    "INSERT INTO product_update_reads (update_id, tenant_id, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE read_at = read_at",
    [updateId, viewer.tenantId, userId],
  )
  return { changed: num(res?.affectedRows) === 1 }
}

/** Mark every currently-visible update read for this user. Returns count newly read. */
export async function markAllRead(viewer: Viewer, userId: number): Promise<number> {
  const { updates } = await listForViewer(viewer, userId)
  let changed = 0
  for (const u of updates) {
    if (u.read) continue
    const r = await markRead(u.id, viewer, userId)
    if (r.changed) changed++
  }
  return changed
}
