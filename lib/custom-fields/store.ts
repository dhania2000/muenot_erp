import "server-only"
/**
 * SPEC 94 — Custom Fields: definition store (Phase 2).
 * ---------------------------------------------------------------------------
 * Reads and writes the per-tenant field DEFINITIONS (metadata). The captured
 * values live in service.ts; this file owns only the schema/definition side.
 *
 * Every statement is tenant-scoped: the acting tenant comes from the request
 * context (never caller input), so one tenant can never read or mutate another
 * tenant's custom-field definitions.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureCustomFieldSchema } from "@/lib/custom-fields/schema"
import {
  type FieldDefInput,
  type FieldDefinition,
  type FieldOption,
  type FieldConfig,
  FIELD_TYPES,
  getFieldTypeDef,
  isFieldType,
  normalizeEntityType,
  normalizeFieldKey,
  validateFieldDef,
} from "@/lib/custom-fields/model"
import { toTenantRole } from "@/lib/role-model"

type DefRow = {
  entity_type: string
  field_key: string
  label: string
  field_type: string
  required: number
  options_json: string | null
  config_json: string | null
  default_json: string | null
  help_text: string
  view_min_role: string
  edit_min_role: string
  active: number
  sort_order: number
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

function rowToDef(row: DefRow): FieldDefinition {
  const type = isFieldType(row.field_type) ? row.field_type : "text"
  const typeDef = getFieldTypeDef(type)
  return {
    entityType: normalizeEntityType(row.entity_type),
    key: row.field_key,
    label: row.label,
    type,
    required: Number(row.required) === 1,
    options: typeDef?.hasOptions ? parseJson<FieldOption[]>(row.options_json, []) : [],
    config: parseJson<FieldConfig>(row.config_json, {}),
    defaultValue: parseJson<unknown>(row.default_json, null),
    helpText: row.help_text ?? "",
    viewMinRole: toTenantRole(row.view_min_role),
    editMinRole: toTenantRole(row.edit_min_role),
    active: Number(row.active) === 1,
    sortOrder: Number(row.sort_order) || 0,
  }
}

/** Every field definition for the tenant, ordered for stable display. */
export async function listDefs(): Promise<FieldDefinition[]> {
  await ensureCustomFieldSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT entity_type, field_key, label, field_type, required, options_json, config_json,
            default_json, help_text, view_min_role, edit_min_role, active, sort_order
       FROM custom_field_defs
      WHERE tenant_id = ?
      ORDER BY entity_type ASC, sort_order ASC, field_key ASC`,
    [tenantId],
  )) as DefRow[]
  return rows.map(rowToDef)
}

/** The tenant's field definitions for one entity type. */
export async function listDefsForEntity(entityType: string): Promise<FieldDefinition[]> {
  const all = await listDefs()
  const key = normalizeEntityType(entityType)
  return all.filter((d) => d.entityType === key)
}

/** Active field definitions for one entity type (the dynamic-form set). */
export async function listActiveDefsForEntity(entityType: string): Promise<FieldDefinition[]> {
  return (await listDefsForEntity(entityType)).filter((d) => d.active)
}

/**
 * Validate and persist one field definition (idempotent upsert on
 * tenant+entity+key). Formula references are validated against the entity's
 * OTHER numeric fields, so a formula can only depend on fields that exist.
 */
export async function saveDef(
  input: FieldDefInput,
  actor: number | null,
): Promise<{ ok: true; def: FieldDefinition } | { ok: false; errors: string[] }> {
  const entityType = normalizeEntityType(input.entityType)
  const targetKey = normalizeFieldKey(input.key || input.label || "")

  // Gather sibling numeric field keys (excluding this field) for formula checks.
  const siblings = await listDefsForEntity(entityType)
  const numericKeys = siblings
    .filter((d) => d.key !== targetKey && (getFieldTypeDef(d.type)?.numeric ?? false))
    .map((d) => d.key)

  const parsed = validateFieldDef(input, numericKeys)
  if (!parsed.ok) return parsed

  await ensureCustomFieldSchema()
  const tenantId = requireCurrentTenantId()
  const d = parsed.def

  await query(
    `INSERT INTO custom_field_defs
       (tenant_id, entity_type, field_key, label, field_type, required, options_json,
        config_json, default_json, help_text, view_min_role, edit_min_role, active, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       label = VALUES(label),
       field_type = VALUES(field_type),
       required = VALUES(required),
       options_json = VALUES(options_json),
       config_json = VALUES(config_json),
       default_json = VALUES(default_json),
       help_text = VALUES(help_text),
       view_min_role = VALUES(view_min_role),
       edit_min_role = VALUES(edit_min_role),
       active = VALUES(active),
       sort_order = VALUES(sort_order)`,
    [
      tenantId,
      d.entityType,
      d.key,
      d.label,
      d.type,
      d.required ? 1 : 0,
      JSON.stringify(d.options),
      JSON.stringify(d.config),
      JSON.stringify(d.defaultValue ?? null),
      d.helpText,
      d.viewMinRole,
      d.editMinRole,
      d.active ? 1 : 0,
      d.sortOrder,
    ],
  )

  return { ok: true, def: d }
}

/**
 * Delete a field definition and every value captured under it. Removing a field
 * that other formulas depend on is blocked so a formula can never dangle.
 */
export async function deleteDef(
  entityType: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureCustomFieldSchema()
  const tenantId = requireCurrentTenantId()
  const entity = normalizeEntityType(entityType)
  const fieldKey = normalizeFieldKey(key)

  const siblings = await listDefsForEntity(entity)
  const dependents = siblings.filter(
    (d) => d.type === "formula" && (d.config.formula ?? "").toLowerCase().match(/[a-z_][a-z0-9_]*/gi)?.includes(fieldKey),
  )
  if (dependents.length > 0) {
    return {
      ok: false,
      error: `Cannot delete: used by formula field${dependents.length > 1 ? "s" : ""} ${dependents.map((d) => d.label).join(", ")}.`,
    }
  }

  await query(`DELETE FROM custom_field_defs WHERE tenant_id = ? AND entity_type = ? AND field_key = ?`, [
    tenantId,
    entity,
    fieldKey,
  ])
  await query(`DELETE FROM custom_field_values WHERE tenant_id = ? AND entity_type = ? AND field_key = ?`, [
    tenantId,
    entity,
    fieldKey,
  ])
  return { ok: true }
}

export { FIELD_TYPES }
