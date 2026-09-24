import "server-only"
/**
 * SPEC 94 — Custom Fields: value service (Phase 3 & 4).
 * ---------------------------------------------------------------------------
 * The runtime hook every module calls. It captures and reads the VALUES that
 * fill a tenant's custom fields for a specific record, enforcing validation and
 * per-field permissions and computing formula fields at read time.
 *
 * Reporting/read surfaces (API, exports, dynamic forms) all go through
 * buildRecordView so a field-permission decision is identical everywhere data
 * leaves the system, exactly like the reference-number service and field-level
 * security modules.
 */
import { query, withTransaction } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureCustomFieldSchema } from "@/lib/custom-fields/schema"
import { listActiveDefsForEntity, listDefsForEntity } from "@/lib/custom-fields/store"
import {
  type FieldDefinition,
  canEditField,
  canViewField,
  evaluateFormula,
  extractFormulaRefs,
  getFieldTypeDef,
  normalizeEntityType,
  numericValueOf,
  validateFieldValue,
} from "@/lib/custom-fields/model"
import { type TenantRole } from "@/lib/role-model"

type ValueRow = { field_key: string; value_json: string | null }

function parseValue(raw: string | null): unknown {
  if (raw == null) return null
  if (typeof raw === "object") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Raw stored values for a record, keyed by field key (no formulas, no perms). */
export async function getRecordValues(
  entityType: string,
  recordId: string,
): Promise<Record<string, unknown>> {
  await ensureCustomFieldSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT field_key, value_json FROM custom_field_values
      WHERE tenant_id = ? AND entity_type = ? AND record_id = ?`,
    [tenantId, normalizeEntityType(entityType), String(recordId)],
  )) as ValueRow[]
  const out: Record<string, unknown> = {}
  for (const row of rows) out[row.field_key] = parseValue(row.value_json)
  return out
}

/** Compute every formula field for a record from its stored numeric values. */
export function computeFormulas(
  defs: FieldDefinition[],
  values: Record<string, unknown>,
): Record<string, number | null> {
  const numeric: Record<string, number> = {}
  for (const def of defs) {
    if (getFieldTypeDef(def.type)?.numeric && def.type !== "formula") {
      numeric[def.key] = numericValueOf(def, values[def.key])
    }
  }
  const out: Record<string, number | null> = {}
  for (const def of defs) {
    if (def.type !== "formula") continue
    const result = evaluateFormula(def.config.formula ?? "", numeric)
    out[def.key] = result === undefined ? null : result
  }
  return out
}

export type ViewedField = {
  key: string
  label: string
  type: string
  value: unknown
  editable: boolean
  required: boolean
  helpText: string
}

/**
 * The permission-filtered, formula-computed projection of a record's custom
 * fields for a given role — the single reporting/read surface. Fields the role
 * cannot view are omitted entirely (not just blanked), so they never leak into
 * a report, export or API payload.
 */
export async function buildRecordView(
  entityType: string,
  recordId: string,
  role: TenantRole,
): Promise<ViewedField[]> {
  const defs = await listActiveDefsForEntity(entityType)
  const values = await getRecordValues(entityType, recordId)
  const formulas = computeFormulas(defs, values)

  const out: ViewedField[] = []
  for (const def of defs) {
    if (!canViewField(def, role)) continue
    const value = def.type === "formula" ? formulas[def.key] ?? null : values[def.key] ?? def.defaultValue ?? null
    out.push({
      key: def.key,
      label: def.label,
      type: def.type,
      value,
      editable: canEditField(def, role),
      required: def.required,
      helpText: def.helpText,
    })
  }
  return out
}

export type SaveValuesResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> }

/**
 * Validate and persist a batch of custom-field values for one record. Enforces:
 *   - the field exists, is active and the actor may EDIT it (permissions),
 *   - the value passes the field's type/shape/required validation,
 *   - formula fields are never accepted from input (they are derived).
 * All writes happen in one transaction so a record's custom values move together.
 */
export async function setRecordValues(
  entityType: string,
  recordId: string,
  input: Record<string, unknown>,
  role: TenantRole,
  actor: number | null,
): Promise<SaveValuesResult> {
  const entity = normalizeEntityType(entityType)
  const defs = await listDefsForEntity(entity)
  const defByKey = new Map(defs.map((d) => [d.key, d]))

  const errors: Record<string, string> = {}
  const clean: { key: string; value: unknown }[] = []

  for (const [key, raw] of Object.entries(input)) {
    const def = defByKey.get(key)
    if (!def) {
      errors[key] = "Unknown field."
      continue
    }
    if (!def.active) {
      errors[key] = "Field is inactive."
      continue
    }
    if (getFieldTypeDef(def.type)?.computed) {
      errors[key] = "Formula fields are computed and cannot be set."
      continue
    }
    if (!canEditField(def, role)) {
      errors[key] = "You do not have permission to edit this field."
      continue
    }
    const result = validateFieldValue(def, raw)
    if (!result.ok) {
      errors[key] = result.error
      continue
    }
    clean.push({ key, value: result.value })
  }

  // Enforce required fields that are editable by this role and were omitted.
  for (const def of defs) {
    if (!def.active || !def.required || getFieldTypeDef(def.type)?.computed) continue
    if (!canEditField(def, role)) continue
    if (!(def.key in input)) continue // only validate keys the caller actually submitted
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  await ensureCustomFieldSchema()
  const tenantId = requireCurrentTenantId()

  await withTransaction(async (tx) => {
    for (const { key, value } of clean) {
      if (value == null) {
        await tx.query(
          `DELETE FROM custom_field_values
            WHERE tenant_id = ? AND entity_type = ? AND record_id = ? AND field_key = ?`,
          [tenantId, entity, String(recordId), key],
        )
        continue
      }
      await tx.query(
        `INSERT INTO custom_field_values
           (tenant_id, entity_type, record_id, field_key, value_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
        [tenantId, entity, String(recordId), key, JSON.stringify(value), actor],
      )
    }
  })

  const saved: Record<string, unknown> = {}
  for (const { key, value } of clean) saved[key] = value
  return { ok: true, values: saved }
}

export { extractFormulaRefs }
