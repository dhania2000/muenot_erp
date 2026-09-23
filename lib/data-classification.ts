import "server-only"
/**
 * Data Classification (server store + request wiring).
 * ---------------------------------------------------------------------------
 * Replaces the frontend-only localStorage placeholder (lib/governance-store.ts)
 * for classification with a real, tenant-scoped, audited, DB-backed model.
 *
 * A classification maps a `module / entity / field` triple to one of five
 * sensitivity levels, plus three enforcement toggles that say WHERE that
 * classification actually bites:
 *
 *   enforce_access     — gate reads of the field/record behind the clearance
 *                        matrix (consumed by field security / API reads).
 *   enforce_export     — redact the field from exports for under-cleared roles.
 *   enforce_retention  — protect the record type from automatic destructive
 *                        retention when the level forbids auto-delete.
 *
 * The per-tenant CLEARANCE MATRIX (level → min role to access/export, and
 * whether auto-delete is permitted) is the configurable policy; it is stored in
 * company_settings as JSON and defaults to DEFAULT_CLEARANCE_MATRIX.
 *
 * Self-heals its schema at runtime (same pattern as lib/ip-allowlist-store.ts)
 * so existing databases converge without a manual migration step.
 */
import { query } from "@/lib/db"
import { getSetting, setGlobalSetting } from "@/lib/settings/server"
import { recordAuditLog } from "@/lib/audit-log-store"
import type { TenantRole } from "@/lib/role-model"
import {
  type ClassificationLevel,
  type ClearanceMatrix,
  type ClassifiedField,
  DEFAULT_CLEARANCE_MATRIX,
  canAccessClassification,
  canAutoDeleteAtLevel,
  normalizeClearanceMatrix,
  redactedExportFields,
  toClassificationLevel,
} from "@/lib/data-classification-model"

export type ClassificationMapping = {
  id: number
  tenantId: number | null
  module: string
  entity: string
  field: string
  level: ClassificationLevel
  enforceAccess: boolean
  enforceExport: boolean
  enforceRetention: boolean
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

type MappingRow = {
  id: number
  tenant_id: number | null
  module: string
  entity: string
  field: string
  level: string
  enforce_access: number
  enforce_export: number
  enforce_retention: number
  created_by: number | null
  created_by_name: string | null
  created_at: string
  updated_at: string
}

const CLEARANCE_SETTING_KEY = "governance.classification.clearance_matrix"

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`data_classifications\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`module\` VARCHAR(96) NOT NULL,
      \`entity\` VARCHAR(96) NOT NULL,
      \`field\` VARCHAR(190) NOT NULL,
      \`level\` VARCHAR(24) NOT NULL DEFAULT 'Internal',
      \`enforce_access\` TINYINT(1) NOT NULL DEFAULT 0,
      \`enforce_export\` TINYINT(1) NOT NULL DEFAULT 1,
      \`enforce_retention\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_classification\` (\`tenant_id\`, \`module\`, \`entity\`, \`field\`),
      KEY \`idx_classification_tenant\` (\`tenant_id\`),
      KEY \`idx_classification_lookup\` (\`tenant_id\`, \`module\`, \`entity\`)
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

function toPublic(row: MappingRow): ClassificationMapping {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    module: row.module,
    entity: row.entity,
    field: row.field,
    level: toClassificationLevel(row.level),
    enforceAccess: Boolean(row.enforce_access),
    enforceExport: Boolean(row.enforce_export),
    enforceRetention: Boolean(row.enforce_retention),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listClassificationMappings(tenantId: number | null): Promise<ClassificationMapping[]> {
  await ensureTable()
  const rows = await query<MappingRow[]>(
    `SELECT c.*, u.name AS created_by_name
       FROM data_classifications c
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.tenant_id = ? OR c.tenant_id IS NULL
      ORDER BY c.module, c.entity, c.field`,
    [tenantId],
  )
  return rows.map(toPublic)
}

export type ClassificationInput = {
  module: string
  entity: string
  field: string
  level: ClassificationLevel
  enforceAccess: boolean
  enforceExport: boolean
  enforceRetention: boolean
}

function validate(input: ClassificationInput): ClassificationInput {
  const module = input.module?.trim()
  const entity = input.entity?.trim()
  const field = input.field?.trim()
  if (!module) throw new Error("Module is required")
  if (!entity) throw new Error("Entity is required")
  if (!field) throw new Error("Field is required")
  return {
    module: module.slice(0, 96),
    entity: entity.slice(0, 96),
    field: field.slice(0, 190),
    level: toClassificationLevel(input.level),
    enforceAccess: Boolean(input.enforceAccess),
    enforceExport: Boolean(input.enforceExport),
    enforceRetention: Boolean(input.enforceRetention),
  }
}

export async function createClassificationMapping(
  tenantId: number | null,
  input: ClassificationInput,
  actor: { userId: number; name?: string; email?: string; role?: string },
): Promise<ClassificationMapping> {
  await ensureTable()
  const v = validate(input)

  // Enforce the tenant-scoped uniqueness ourselves for a friendly error rather
  // than surfacing a raw ER_DUP_ENTRY.
  const existing = await query<{ id: number }[]>(
    `SELECT id FROM data_classifications WHERE (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL)) AND module = ? AND entity = ? AND field = ? LIMIT 1`,
    [tenantId, tenantId, v.module, v.entity, v.field],
  )
  if (existing.length > 0) {
    throw new Error("A classification for this module / entity / field already exists")
  }

  const res = await query<{ insertId: number }>(
    `INSERT INTO data_classifications
       (tenant_id, module, entity, field, level, enforce_access, enforce_export, enforce_retention, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      v.module,
      v.entity,
      v.field,
      v.level,
      v.enforceAccess ? 1 : 0,
      v.enforceExport ? 1 : 0,
      v.enforceRetention ? 1 : 0,
      actor.userId,
    ],
  )
  const id = (res as any).insertId as number
  await recordAuditLog({
    action: "data_classification.create",
    entityType: "data_classification",
    entityId: id,
    entityLabel: `${v.module} / ${v.entity} / ${v.field}`,
    after: { ...v },
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role ?? null,
    },
  })
  const rows = await query<MappingRow[]>(
    `SELECT c.*, u.name AS created_by_name FROM data_classifications c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`,
    [id],
  )
  return toPublic(rows[0])
}

export async function updateClassificationMapping(
  tenantId: number | null,
  id: number,
  input: ClassificationInput,
  actor: { userId: number; name?: string; email?: string; role?: string },
): Promise<ClassificationMapping | null> {
  await ensureTable()
  const v = validate(input)
  const current = await query<MappingRow[]>(
    `SELECT * FROM data_classifications WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
    [id, tenantId],
  )
  if (current.length === 0) return null
  const before = toPublic(current[0])

  await query(
    `UPDATE data_classifications
        SET module = ?, entity = ?, field = ?, level = ?, enforce_access = ?, enforce_export = ?, enforce_retention = ?
      WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`,
    [
      v.module,
      v.entity,
      v.field,
      v.level,
      v.enforceAccess ? 1 : 0,
      v.enforceExport ? 1 : 0,
      v.enforceRetention ? 1 : 0,
      id,
      tenantId,
    ],
  )
  await recordAuditLog({
    action: "data_classification.update",
    entityType: "data_classification",
    entityId: id,
    entityLabel: `${v.module} / ${v.entity} / ${v.field}`,
    before: {
      module: before.module,
      entity: before.entity,
      field: before.field,
      level: before.level,
      enforceAccess: before.enforceAccess,
      enforceExport: before.enforceExport,
      enforceRetention: before.enforceRetention,
    },
    after: { ...v },
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role ?? null,
    },
  })
  const rows = await query<MappingRow[]>(
    `SELECT c.*, u.name AS created_by_name FROM data_classifications c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`,
    [id],
  )
  return toPublic(rows[0])
}

export async function deleteClassificationMapping(
  tenantId: number | null,
  id: number,
  actor: { userId: number; name?: string; email?: string; role?: string },
): Promise<boolean> {
  await ensureTable()
  const current = await query<MappingRow[]>(
    `SELECT * FROM data_classifications WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
    [id, tenantId],
  )
  if (current.length === 0) return false
  const before = toPublic(current[0])
  await query(`DELETE FROM data_classifications WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [id, tenantId])
  await recordAuditLog({
    action: "data_classification.delete",
    entityType: "data_classification",
    entityId: id,
    entityLabel: `${before.module} / ${before.entity} / ${before.field}`,
    before: {
      module: before.module,
      entity: before.entity,
      field: before.field,
      level: before.level,
    },
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role ?? null,
    },
  })
  return true
}

// ---------------------------------------------------------------------------
// Clearance matrix (configurable enforcement policy)
// ---------------------------------------------------------------------------

export async function getClearanceMatrix(): Promise<ClearanceMatrix> {
  const raw = await getSetting(CLEARANCE_SETTING_KEY)
  if (!raw) return normalizeClearanceMatrix(DEFAULT_CLEARANCE_MATRIX)
  try {
    return normalizeClearanceMatrix(JSON.parse(raw))
  } catch {
    return normalizeClearanceMatrix(DEFAULT_CLEARANCE_MATRIX)
  }
}

export async function setClearanceMatrix(
  tenantId: number | null,
  matrix: ClearanceMatrix,
  actor: { userId: number; name?: string; email?: string; role?: string },
): Promise<ClearanceMatrix> {
  const normalized = normalizeClearanceMatrix(matrix)
  await setGlobalSetting(CLEARANCE_SETTING_KEY, JSON.stringify(normalized))
  await recordAuditLog({
    action: "data_classification.clearance_update",
    entityType: "data_classification_policy",
    entityId: "clearance_matrix",
    entityLabel: "Classification clearance matrix",
    after: normalized as unknown as Record<string, unknown>,
    context: {
      tenantId,
      actorUserId: actor.userId,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role ?? null,
    },
  })
  return normalized
}

// ---------------------------------------------------------------------------
// Enforcement helpers — consumed by the access / export / retention surfaces.
// ---------------------------------------------------------------------------

/** All classified fields for an entity, as the pure model's ClassifiedField shape. */
export async function classifiedFieldsFor(
  tenantId: number | null,
  module: string,
  entity: string,
): Promise<(ClassifiedField & { enforceAccess: boolean; enforceRetention: boolean })[]> {
  await ensureTable()
  const rows = await query<MappingRow[]>(
    `SELECT * FROM data_classifications
      WHERE (tenant_id = ? OR tenant_id IS NULL) AND module = ? AND entity = ?`,
    [tenantId, module, entity],
  )
  return rows.map((r) => ({
    field: r.field,
    level: toClassificationLevel(r.level),
    enforceExport: Boolean(r.enforce_export),
    enforceAccess: Boolean(r.enforce_access),
    enforceRetention: Boolean(r.enforce_retention),
  }))
}

/**
 * EXPORT enforcement. Given rows plus the entity's classification, remove every
 * field an under-cleared role may not export. Returns the sanitized rows and
 * the set of redacted field names. Fields without export enforcement pass
 * through untouched. Pure over its inputs so it is trivially testable and can
 * be called from any export chokepoint.
 */
export function enforceExportClassification<T extends Record<string, unknown>>(
  rows: T[],
  fields: ClassifiedField[],
  role: TenantRole,
  matrix: ClearanceMatrix,
): { rows: Partial<T>[]; redacted: string[] } {
  const redacted = redactedExportFields(fields, role, matrix)
  if (redacted.size === 0) return { rows, redacted: [] }
  const sanitized = rows.map((row) => {
    const copy: Partial<T> = { ...row }
    for (const key of redacted) delete copy[key as keyof T]
    return copy
  })
  return { rows: sanitized, redacted: [...redacted] }
}

/**
 * ACCESS enforcement. Given the acting role, return the set of fields the role
 * may NOT read (access enforcement enabled AND role under-cleared). Callers
 * redact or 403 accordingly.
 */
export async function fieldsBlockedForAccess(
  tenantId: number | null,
  module: string,
  entity: string,
  role: TenantRole,
): Promise<Set<string>> {
  const [fields, matrix] = await Promise.all([
    classifiedFieldsFor(tenantId, module, entity),
    getClearanceMatrix(),
  ])
  const blocked = new Set<string>()
  for (const f of fields) {
    if (!f.enforceAccess) continue
    if (!canAccessClassification(f.level, role, matrix)) blocked.add(f.field)
  }
  return blocked
}

/**
 * RETENTION enforcement. Whether a destructive (Delete) retention action may
 * run automatically on `module/entity`. Blocked when ANY retention-enforced
 * field is classified at a level whose clearance rule forbids auto-delete.
 * Archive (non-destructive) is always allowed and should skip this check.
 */
export async function isAutoDeleteBlockedByClassification(
  tenantId: number | null,
  module: string,
  entity: string,
): Promise<{ blocked: boolean; level: ClassificationLevel | null }> {
  const [fields, matrix] = await Promise.all([
    classifiedFieldsFor(tenantId, module, entity),
    getClearanceMatrix(),
  ])
  let worst: ClassificationLevel | null = null
  for (const f of fields) {
    if (!f.enforceRetention) continue
    if (!canAutoDeleteAtLevel(f.level, matrix)) {
      if (worst == null) worst = f.level
    }
  }
  return { blocked: worst != null, level: worst }
}
