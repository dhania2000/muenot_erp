import "server-only"
/**
 * SPEC 93 — Reference Number Management: config store (Phase 2).
 * ---------------------------------------------------------------------------
 * Reads and writes the per-tenant, per-(document type, reference type)
 * CONFIGURATION — whether a reference is captured, required, and how duplicates
 * are handled. The actual reference values live in service.ts; this file only
 * owns the configuration side.
 *
 * Every statement is tenant-scoped: the acting tenant is taken from the request
 * context (never from caller input), so one tenant can never read or mutate
 * another's reference configuration.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureReferenceSchema } from "@/lib/references/schema"
import {
  type ConfigInput,
  type DuplicatePolicy,
  type ReferenceConfig,
  type ReferenceType,
  DOCUMENT_TYPES,
  REFERENCE_TYPES,
  defaultConfig,
  isDuplicatePolicy,
  isReferenceType,
  validateConfigInput,
} from "@/lib/references/model"

type ConfigRow = {
  document_type: string
  ref_type: string
  enabled: number
  required: number
  duplicate_policy: string
}

function rowKey(docType: string, refType: string): string {
  return `${docType}::${refType}`
}

function rowToConfig(row: ConfigRow): ReferenceConfig {
  return {
    docType: String(row.document_type).toUpperCase(),
    refType: (isReferenceType(row.ref_type) ? row.ref_type : "external") as ReferenceType,
    enabled: Number(row.enabled) === 1,
    required: Number(row.required) === 1,
    duplicate: (isDuplicatePolicy(row.duplicate_policy) ? row.duplicate_policy : "off") as DuplicatePolicy,
  }
}

/** Load every stored config row for the tenant, keyed by document::ref. */
async function loadStored(): Promise<Map<string, ConfigRow>> {
  await ensureReferenceSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT document_type, ref_type, enabled, required, duplicate_policy
       FROM reference_configs
      WHERE tenant_id = ?`,
    [tenantId],
  )) as ConfigRow[]
  const map = new Map<string, ConfigRow>()
  for (const row of rows) map.set(rowKey(String(row.document_type).toUpperCase(), row.ref_type), row)
  return map
}

/**
 * The single effective config for a (document, reference) pair: the tenant's
 * stored override if present, otherwise the catalogue default. This is the
 * authoritative resolver the service uses before capturing a value.
 */
export async function effectiveConfig(docType: string, refType: string): Promise<ReferenceConfig> {
  const stored = await loadStored()
  const key = rowKey(String(docType).toUpperCase(), refType)
  const row = stored.get(key)
  return row ? rowToConfig(row) : defaultConfig(docType, refType)
}

export type DocumentConfig = {
  docType: string
  label: string
  module: string
  custom: boolean
  configs: ReferenceConfig[]
}

/**
 * The full configuration matrix for the console: every catalogue document with
 * its six reference-type configs, using stored overrides where present. `custom`
 * flags documents the tenant has tailored at least one reference on.
 */
export async function listConfigs(): Promise<DocumentConfig[]> {
  const stored = await loadStored()

  return DOCUMENT_TYPES.map((doc) => {
    let custom = false
    const configs = REFERENCE_TYPES.map((rt) => {
      const row = stored.get(rowKey(doc.docType, rt.type))
      if (row) {
        custom = true
        return rowToConfig(row)
      }
      return doc.defaults.find((c) => c.refType === rt.type) ?? defaultConfig(doc.docType, rt.type)
    })
    return { docType: doc.docType, label: doc.label, module: doc.module, custom, configs }
  })
}

/** Validate and persist one config (idempotent upsert on tenant+doc+ref). */
export async function saveConfig(
  input: ConfigInput,
  updatedBy: number | null,
): Promise<{ ok: true; config: ReferenceConfig } | { ok: false; errors: string[] }> {
  const parsed = validateConfigInput(input)
  if (!parsed.ok) return parsed

  await ensureReferenceSchema()
  const tenantId = requireCurrentTenantId()
  const c = parsed.config

  await query(
    `INSERT INTO reference_configs
       (tenant_id, document_type, ref_type, enabled, required, duplicate_policy, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       required = VALUES(required),
       duplicate_policy = VALUES(duplicate_policy),
       updated_by = VALUES(updated_by)`,
    [tenantId, c.docType, c.refType, c.enabled ? 1 : 0, c.required ? 1 : 0, c.duplicate, updatedBy],
  )

  return { ok: true, config: c }
}

/**
 * Remove a tenant's custom config for a (document, reference) pair, reverting it
 * to the catalogue default. Captured reference values are left untouched.
 */
export async function deleteConfig(docType: string, refType: string): Promise<boolean> {
  await ensureReferenceSchema()
  const tenantId = requireCurrentTenantId()
  const res = (await query(
    `DELETE FROM reference_configs WHERE tenant_id = ? AND document_type = ? AND ref_type = ?`,
    [tenantId, String(docType).toUpperCase(), refType],
  )) as { affectedRows?: number }
  return (res?.affectedRows ?? 0) > 0
}
