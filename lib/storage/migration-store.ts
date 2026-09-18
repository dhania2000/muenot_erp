import "server-only"
import { query } from "@/lib/db"
import { scopedWhere, tenantInsert, tenantDelete } from "@/lib/tenant-scope"

/**
 * Storage → Migration mappings.
 * ---------------------------------------------------------------------------
 * Each row connects an ERP module + sub-module's data to a specific folder in
 * the tenant's connected storage (or the active/managed storage when no
 * connection is chosen). Rows are tenant-owned (registered in
 * lib/tenant-tables.ts) so every read/write is automatically tenant-scoped.
 */

const TABLE = "tenant_storage_migrations"

let ensured = false

export async function ensureMigrationSchema(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      module_key VARCHAR(80) NOT NULL,
      module_label VARCHAR(190) NOT NULL,
      submodule_key VARCHAR(120) NOT NULL,
      submodule_label VARCHAR(190) NOT NULL,
      connection_id BIGINT DEFAULT NULL,
      folder VARCHAR(500) NOT NULL,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tsm_target (tenant_id, module_key, submodule_key),
      KEY idx_tsm_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  ensured = true
}

/**
 * Normalize a folder path: trim, strip leading/trailing slashes and any
 * empty/".." segments so a folder can never escape the storage namespace.
 */
export function normalizeFolder(value: string | null | undefined): string {
  if (!value) return ""
  return value
    .trim()
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/")
}

export type MigrationMapping = {
  id: number
  moduleKey: string
  moduleLabel: string
  subModuleKey: string
  subModuleLabel: string
  connectionId: number | null
  folder: string
  createdAt: string | null
}

function rowToMapping(r: any): MigrationMapping {
  return {
    id: Number(r.id),
    moduleKey: r.module_key,
    moduleLabel: r.module_label,
    subModuleKey: r.submodule_key,
    subModuleLabel: r.submodule_label,
    connectionId: r.connection_id != null ? Number(r.connection_id) : null,
    folder: r.folder,
    createdAt: r.created_at ?? null,
  }
}

export async function listMigrations(): Promise<MigrationMapping[]> {
  await ensureMigrationSchema()
  const { where, params } = scopedWhere(TABLE)
  const rows = await query<any[]>(`SELECT * FROM ${TABLE} ${where} ORDER BY id DESC`, params)
  return rows.map(rowToMapping)
}

export type MigrationInput = {
  moduleKey: string
  moduleLabel: string
  subModuleKey: string
  subModuleLabel: string
  connectionId?: number | null
  folder: string
}

export async function createMigration(
  input: MigrationInput,
  userId?: number,
): Promise<{ id: number } | { error: string }> {
  await ensureMigrationSchema()
  const folder = normalizeFolder(input.folder)
  if (!input.moduleKey || !input.subModuleKey) return { error: "Select a module and sub-module" }
  if (!folder) return { error: "A storage folder is required" }

  // One mapping per (module, sub-module): replace an existing target.
  await tenantDelete(TABLE, "module_key = ? AND submodule_key = ?", [input.moduleKey, input.subModuleKey])
  const { insertId } = await tenantInsert(TABLE, {
    module_key: input.moduleKey,
    module_label: input.moduleLabel,
    submodule_key: input.subModuleKey,
    submodule_label: input.subModuleLabel,
    connection_id: input.connectionId ?? null,
    folder,
    created_by: userId ?? null,
  })
  return { id: insertId }
}

export async function deleteMigration(id: number): Promise<{ ok: true } | { error: string }> {
  await ensureMigrationSchema()
  const affected = await tenantDelete(TABLE, "id = ?", [id])
  return affected > 0 ? { ok: true } : { error: "Mapping not found" }
}
