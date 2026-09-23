import "server-only"
/**
 * Runtime self-heal for tenant data isolation.
 * ---------------------------------------------------------------------------
 * Mirrors database/migrations/2026-11-07-tenant-data-isolation.sql so existing
 * databases converge on the isolated schema without a manual migration step
 * (same approach as lib/tenant-service.ts and lib/clients-db.ts). Adds the
 * `tenant_id` column, covering index, and foreign key to every tenant-owned
 * table (lib/tenant-tables.ts) and backfills existing rows onto the default
 * platform-owner tenant.
 *
 * Kept in its own module (not lib/tenant-guard.ts) so the guard stays a pure,
 * dependency-light unit that lib/db.ts can import without a cycle.
 */
import { query } from "@/lib/db"
import { TENANT_COLUMN, TENANT_OWNED_TABLES } from "@/lib/tenant-tables"
import { ensureTenantSchema, getDefaultTenant } from "@/lib/tenant-service"

let ensured: Promise<void> | null = null

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  )
  return rows.length > 0
}
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}
async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )
  return rows.length > 0
}
async function fkExists(table: string, name: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ? AND constraint_type = 'FOREIGN KEY' LIMIT 1`,
    [table, name],
  )
  return rows.length > 0
}

async function runEnsure(): Promise<void> {
  await ensureTenantSchema() // guarantees `tenants` + default tenant exist
  const def = await getDefaultTenant()
  const defaultId = def?.id ?? null

  for (const table of TENANT_OWNED_TABLES) {
    try {
      if (!(await tableExists(table))) continue
      if (!(await columnExists(table, TENANT_COLUMN))) {
        await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${TENANT_COLUMN}\` INT UNSIGNED DEFAULT NULL`)
      }
      const idx = `idx_${table}_tenant`
      if (!(await indexExists(table, idx))) {
        await query(`ALTER TABLE \`${table}\` ADD KEY \`${idx}\` (\`${TENANT_COLUMN}\`)`)
      }
      if (defaultId != null) {
        await query(`UPDATE \`${table}\` SET \`${TENANT_COLUMN}\` = ? WHERE \`${TENANT_COLUMN}\` IS NULL`, [
          defaultId,
        ])
      }
      const fk = `fk_${table}_tenant`
      if (!(await fkExists(table, fk))) {
        // FK can fail on legacy engines/data; non-fatal — the column + index +
        // app-layer guard still deliver isolation.
        await query(
          `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fk}\` FOREIGN KEY (\`${TENANT_COLUMN}\`) REFERENCES \`tenants\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`,
        ).catch(() => {})
      }
    } catch (err) {
      console.error(`[tenant-ensure] self-heal failed for ${table}:`, err)
    }
  }
}

/**
 * Ensure every tenant-owned table has its tenant_id column, index, FK, and
 * backfill. Cached per process; safe to call often.
 */
export async function ensureTenantIsolation(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}
