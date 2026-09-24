import "server-only"
/**
 * Custom Report Builder — saved-report store (DB-backed, tenant-scoped, audited).
 * ---------------------------------------------------------------------------
 * Persists report DEFINITIONS (never raw data) so authorized users can save,
 * re-run, and share reports. Follows the self-healing-schema pattern of
 * lib/data-export-store.ts: the table is created on first use so existing
 * databases converge with no manual migration. Every read/write is tenant
 * scoped (`tenant_id <=> ?`) and every mutation is written to the immutable
 * audit log.
 *
 * The stored definition is validated against the catalog on both save and run,
 * so a definition that somehow drifts out of the allowlist is rejected at run
 * time by the query engine rather than trusted.
 */
import { query } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { getReportSource } from "@/lib/reports/catalog"
import { validateReportDefinition, type ReportDefinition } from "@/lib/reports/model"
import type { TenantRole } from "@/lib/role-model"

export type Actor = { userId: number; name?: string | null; email?: string | null; role: TenantRole }

export type SavedReport = {
  id: number
  tenantId: number | null
  name: string
  description: string | null
  sourceKey: string
  definition: ReportDefinition
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

type ReportRow = {
  id: number
  tenant_id: number | null
  name: string
  description: string | null
  source_key: string
  definition: string
  created_by: number | null
  created_by_name: string | null
  created_at: string
  updated_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`custom_reports\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`name\` VARCHAR(190) NOT NULL,
      \`description\` VARCHAR(500) DEFAULT NULL,
      \`source_key\` VARCHAR(120) NOT NULL,
      \`definition\` JSON NOT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_custom_report_tenant\` (\`tenant_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
}

function ensureTable(): Promise<void> {
  if (!ensured)
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  return ensured
}

function toPublic(row: ReportRow): SavedReport {
  let definition: ReportDefinition
  try {
    definition = typeof row.definition === "string" ? JSON.parse(row.definition) : (row.definition as unknown as ReportDefinition)
  } catch {
    definition = { sourceKey: row.source_key, columns: [], filters: [], groupBy: [], sort: [], dateRange: null, limit: null }
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    sourceKey: row.source_key,
    definition,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT = `
  SELECT r.id, r.tenant_id, r.name, r.description, r.source_key, r.definition,
         r.created_by, u.name AS created_by_name, r.created_at, r.updated_at
    FROM custom_reports r
    LEFT JOIN users u ON u.id = r.created_by`

export async function listReports(tenantId: number | null): Promise<SavedReport[]> {
  await ensureTable()
  const rows = await query<ReportRow[]>(`${SELECT} WHERE r.tenant_id <=> ? ORDER BY r.updated_at DESC`, [tenantId])
  return rows.map(toPublic)
}

export async function getReport(tenantId: number | null, id: number): Promise<SavedReport | null> {
  await ensureTable()
  const rows = await query<ReportRow[]>(`${SELECT} WHERE r.id = ? AND r.tenant_id <=> ? LIMIT 1`, [id, tenantId])
  return rows[0] ? toPublic(rows[0]) : null
}

export type SaveReportInput = {
  name: string
  description?: string | null
  definition: unknown
}

/** Validate a definition against the catalog, returning the normalized form. */
function validateOrThrow(rawDefinition: unknown): ReportDefinition {
  const sourceKey = String((rawDefinition as ReportDefinition)?.sourceKey ?? "")
  const source = getReportSource(sourceKey)
  if (!source) throw new Error("Unknown data source.")
  const result = validateReportDefinition(source, rawDefinition)
  if (!result.ok) throw new Error(result.errors[0] ?? "Invalid report definition")
  return result.definition
}

export async function createReport(tenantId: number | null, input: SaveReportInput, actor: Actor): Promise<SavedReport> {
  await ensureTable()
  const name = String(input.name ?? "").trim()
  if (!name) throw new Error("A report name is required.")
  const definition = validateOrThrow(input.definition)
  const description = input.description ? String(input.description).slice(0, 500) : null

  const res = await query<{ insertId: number }>(
    `INSERT INTO custom_reports (tenant_id, name, description, source_key, definition, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tenantId, name.slice(0, 190), description, definition.sourceKey, JSON.stringify(definition), actor.userId],
  )
  const id = (res as any).insertId as number
  await audit("custom_report.create", id, name, definition, tenantId, actor)
  const saved = await getReport(tenantId, id)
  return saved as SavedReport
}

export async function updateReport(
  tenantId: number | null,
  id: number,
  input: SaveReportInput,
  actor: Actor,
): Promise<SavedReport> {
  await ensureTable()
  const existing = await getReport(tenantId, id)
  if (!existing) throw new Error("Report not found.")
  const name = String(input.name ?? "").trim()
  if (!name) throw new Error("A report name is required.")
  const definition = validateOrThrow(input.definition)
  const description = input.description ? String(input.description).slice(0, 500) : null

  await query(
    `UPDATE custom_reports SET name = ?, description = ?, source_key = ?, definition = ?
      WHERE id = ? AND tenant_id <=> ?`,
    [name.slice(0, 190), description, definition.sourceKey, JSON.stringify(definition), id, tenantId],
  )
  await audit("custom_report.update", id, name, definition, tenantId, actor)
  const saved = await getReport(tenantId, id)
  return saved as SavedReport
}

export async function deleteReport(tenantId: number | null, id: number, actor: Actor): Promise<boolean> {
  await ensureTable()
  const existing = await getReport(tenantId, id)
  if (!existing) return false
  await query(`DELETE FROM custom_reports WHERE id = ? AND tenant_id <=> ?`, [id, tenantId])
  await audit("custom_report.delete", id, existing.name, existing.definition, tenantId, actor)
  return true
}

async function audit(
  action: string,
  id: number,
  label: string,
  definition: ReportDefinition,
  tenantId: number | null,
  actor: Actor,
) {
  await recordAuditLog({
    action,
    entityType: "custom_report",
    entityId: id,
    entityLabel: label,
    after: { sourceKey: definition.sourceKey, columns: definition.columns.length, filters: definition.filters.length },
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role,
    },
  }).catch(() => {})
}
