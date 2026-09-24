import "server-only"
/**
 * SPEC 96 — Custom Module Framework: definition store (Phase 3).
 * ---------------------------------------------------------------------------
 * Reads and writes the per-tenant module DEFINITIONS. Records live in
 * service.ts; this file owns only the module/metadata side.
 *
 * Every statement is tenant-scoped: the acting tenant comes from the request
 * context (never caller input), so one tenant can never read or mutate another
 * tenant's modules.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureCustomModuleSchema } from "@/lib/custom-modules/schema"
import {
  type ListView,
  type ModuleDefInput,
  type ModuleDefinition,
  type ModuleField,
  type ModulePermissions,
  type ModuleReport,
  type ModuleStatus,
  type ModuleWorkflow,
  DEFAULT_PERMISSIONS,
  EMPTY_WORKFLOW,
  normalizeSlug,
  validateModuleDefinition,
} from "@/lib/custom-modules/model"

type ModuleRow = {
  id: number
  slug: string
  name: string
  plural_name: string
  description: string
  icon: string
  nav_group: string
  status: string
  allow_attachments: number
  fields_json: string | null
  list_view_json: string | null
  permissions_json: string | null
  workflow_json: string | null
  reports_json: string | null
  version: number
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToModule(row: ModuleRow): ModuleDefinition {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    pluralName: row.plural_name || `${row.name}s`,
    description: row.description ?? "",
    icon: row.icon || "Blocks",
    navGroup: row.nav_group || "Custom",
    status: (["draft", "published", "archived"].includes(row.status) ? row.status : "draft") as ModuleStatus,
    allowAttachments: Number(row.allow_attachments) === 1,
    fields: parseJson<ModuleField[]>(row.fields_json, []),
    listView: parseJson<ListView>(row.list_view_json, { columns: [] }),
    permissions: parseJson<ModulePermissions>(row.permissions_json, { ...DEFAULT_PERMISSIONS }),
    workflow: parseJson<ModuleWorkflow>(row.workflow_json, { ...EMPTY_WORKFLOW }),
    reports: parseJson<ModuleReport[]>(row.reports_json, []),
    version: Number(row.version) || 1,
  }
}

const COLUMNS = `id, slug, name, plural_name, description, icon, nav_group, status, allow_attachments,
                 fields_json, list_view_json, permissions_json, workflow_json, reports_json, version`

/** Every module definition for the tenant, newest first. */
export async function listModules(): Promise<ModuleDefinition[]> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT ${COLUMNS} FROM custom_modules WHERE tenant_id = ? ORDER BY updated_at DESC, id DESC`,
    [tenantId],
  )) as ModuleRow[]
  return rows.map(rowToModule)
}

/** One module by id, scoped to the tenant. */
export async function getModuleById(id: number): Promise<ModuleDefinition | null> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(`SELECT ${COLUMNS} FROM custom_modules WHERE tenant_id = ? AND id = ? LIMIT 1`, [
    tenantId,
    id,
  ])) as ModuleRow[]
  return rows[0] ? rowToModule(rows[0]) : null
}

/** One module by slug, scoped to the tenant (used by the record API + renderer). */
export async function getModuleBySlug(slug: string): Promise<ModuleDefinition | null> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(`SELECT ${COLUMNS} FROM custom_modules WHERE tenant_id = ? AND slug = ? LIMIT 1`, [
    tenantId,
    normalizeSlug(slug),
  ])) as ModuleRow[]
  return rows[0] ? rowToModule(rows[0]) : null
}

/**
 * Validate and persist a module definition. Creates when `id` is absent,
 * updates in place otherwise, bumping the version on every save so records can
 * pin the schema they were captured against. The slug is made unique per
 * tenant.
 */
export async function saveModule(
  input: ModuleDefInput,
  actor: number | null,
): Promise<{ ok: true; module: ModuleDefinition } | { ok: false; errors: string[] }> {
  const parsed = validateModuleDefinition(input)
  if (!parsed.ok) return parsed

  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const def = parsed.def
  const slug = await uniqueSlug(tenantId, def.slug, input.id ?? null)
  def.slug = slug

  const payload = [
    slug,
    def.name,
    def.pluralName,
    def.description,
    def.icon,
    def.navGroup,
    def.status,
    def.allowAttachments ? 1 : 0,
    JSON.stringify(def.fields),
    JSON.stringify(def.listView),
    JSON.stringify(def.permissions),
    JSON.stringify(def.workflow),
    JSON.stringify(def.reports),
  ]

  if (input.id) {
    const existing = await getModuleById(input.id)
    if (!existing) return { ok: false, errors: ["Module not found."] }
    const version = existing.version + 1
    def.version = version
    await query(
      `UPDATE custom_modules
          SET slug = ?, name = ?, plural_name = ?, description = ?, icon = ?, nav_group = ?,
              status = ?, allow_attachments = ?, fields_json = ?, list_view_json = ?,
              permissions_json = ?, workflow_json = ?, reports_json = ?, version = ?
        WHERE tenant_id = ? AND id = ?`,
      [...payload, version, tenantId, input.id],
    )
    def.id = input.id
    return { ok: true, module: def }
  }

  def.version = 1
  const result = (await query(
    `INSERT INTO custom_modules
       (tenant_id, slug, name, plural_name, description, icon, nav_group, status, allow_attachments,
        fields_json, list_view_json, permissions_json, workflow_json, reports_json, version, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, ...payload, 1, actor],
  )) as { insertId?: number }
  def.id = result.insertId ?? null
  return { ok: true, module: def }
}

/** Change only a module's lifecycle status (draft / published / archived). */
export async function setModuleStatus(
  id: number,
  status: ModuleStatus,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const res = (await query(`UPDATE custom_modules SET status = ? WHERE tenant_id = ? AND id = ?`, [
    status,
    tenantId,
    id,
  ])) as { affectedRows?: number }
  if (!res.affectedRows) return { ok: false, error: "Module not found." }
  return { ok: true }
}

/** Delete a module and all of its records. */
export async function deleteModule(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  await query(`DELETE FROM custom_module_records WHERE tenant_id = ? AND module_id = ?`, [tenantId, id])
  const res = (await query(`DELETE FROM custom_modules WHERE tenant_id = ? AND id = ?`, [tenantId, id])) as {
    affectedRows?: number
  }
  if (!res.affectedRows) return { ok: false, error: "Module not found." }
  return { ok: true }
}

/** Make a slug unique within the tenant, ignoring the row being updated. */
async function uniqueSlug(tenantId: number, base: string, ignoreId: number | null): Promise<string> {
  const rows = (await query(`SELECT id, slug FROM custom_modules WHERE tenant_id = ?`, [tenantId])) as {
    id: number
    slug: string
  }[]
  const taken = new Set(rows.filter((r) => r.id !== ignoreId).map((r) => r.slug))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
