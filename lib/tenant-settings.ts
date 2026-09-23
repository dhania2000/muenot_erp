import "server-only"

/**
 * Canonical tenant configuration store.
 *
 * The old `company_settings` table is deliberately kept as an inherited
 * platform baseline for backwards compatibility. All new writes go to this
 * table, which gives every tenant an isolated override layer:
 *
 *   environment > tenant override > legacy/platform baseline > default
 *
 * Secrets use the same master key as the rest of the application and are never
 * returned by the public projection. Empty values clear an override, allowing
 * a tenant to return to its inherited value without deleting the key from the
 * registry.
 */

import { query, withTransaction } from "@/lib/db"
import { guardQuery } from "@/lib/tenant-guard"
import type { PoolConnection } from "mysql2/promise"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureTenantSchema } from "@/lib/tenant-service"
import { companySettingsSections, getSectionDefaults, type FieldType } from "@/lib/company-settings-config"
import { CONFIG_REGISTRY, getDescriptor } from "@/lib/config/registry"
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/secrets/crypto"
import { decryptToken } from "@/lib/token-crypto"
import { cachedForTenant, invalidateTenantTarget } from "@/lib/tenant-cache"

export const MASKED_SECRET = "••••••••"

export type TenantSettingDefinition = {
  key: string
  label: string
  type: FieldType | "text"
  options?: string[]
  default?: string
  secret: boolean
}

export type TenantSettingRow = {
  skey: string
  svalue: string | null
  value_type: string
  is_secret: number | boolean
  updated_at?: string
}

export type TenantSettingAudit = {
  key: string
  action: "set" | "clear"
  hadPreviousValue: boolean
  hasNewValue: boolean
}

export type TenantSettingAuditRecord = TenantSettingAudit & {
  id: number
  actor_user_id: number | null
  created_at: string
}

async function transactionQuery<T = any>(connection: PoolConnection, sql: string, params: any[] = []): Promise<T> {
  // The pooled transaction bypasses lib/db#query, so explicitly apply the same
  // fail-closed tenant inspection before every statement.
  guardQuery(sql)
  const [rows] = await connection.query(sql, params)
  return rows as T
}

const fieldDefinitions = new Map<string, TenantSettingDefinition>()
for (const section of companySettingsSections) {
  for (const field of section.fields) {
    fieldDefinitions.set(field.key, {
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options,
      default: field.default,
      secret: Boolean(field.secret),
    })
  }
}

// tenant descriptors that are not represented by the older form-based
// settings catalog are still valid tenant keys and are validated as text.
for (const descriptor of CONFIG_REGISTRY) {
  if (descriptor.scope !== "tenant" || fieldDefinitions.has(descriptor.key)) continue
  fieldDefinitions.set(descriptor.key, {
    key: descriptor.key,
    label: descriptor.label,
    type: "text",
    default: descriptor.default,
    secret: Boolean(descriptor.secret),
  })
}

export function getTenantSettingDefinition(key: string): TenantSettingDefinition | null {
  return fieldDefinitions.get(key) ?? null
}

export function listTenantSettingDefinitions(): TenantSettingDefinition[] {
  return [...fieldDefinitions.values()]
}

function valueType(type: TenantSettingDefinition["type"]): string {
  if (type === "number") return "number"
  if (type === "toggle") return "toggle"
  if (type === "select") return "select"
  return "text"
}

/** Strict, server-side validation shared by every API and future import path. */
export function validateTenantSetting(key: string, value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const definition = getTenantSettingDefinition(key)
  if (!definition) return { ok: false, error: `Unknown setting: ${key}` }
  if (value == null || String(value).trim() === "") return { ok: true, value: "" }
  if (typeof value === "object" || typeof value === "function") {
    return { ok: false, error: `${definition.label} must be a scalar value` }
  }
  const normalized = String(value).trim()
  if (normalized.length > 20_000) return { ok: false, error: `${definition.label} is too long` }

  if (definition.type === "number") {
    const n = Number(normalized)
    if (!Number.isFinite(n)) return { ok: false, error: `${definition.label} must be a number` }
  }
  if (definition.type === "select" || definition.type === "toggle") {
    if (definition.options?.length && !definition.options.includes(normalized)) {
      return { ok: false, error: `${definition.label} has an invalid option` }
    }
  }
  if (definition.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: `${definition.label} must be a valid email address` }
  }
  if (definition.type === "url") {
    try {
      const parsed = new URL(normalized)
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol")
    } catch {
      return { ok: false, error: `${definition.label} must be a valid http(s) URL` }
    }
  }
  if (definition.type === "color" && !/^#[0-9a-f]{3,8}$/i.test(normalized)) {
    return { ok: false, error: `${definition.label} must be a hex colour` }
  }
  return { ok: true, value: normalized }
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await ensureTenantSchema()
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_settings\` (
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`skey\` VARCHAR(160) NOT NULL,
      \`svalue\` LONGTEXT DEFAULT NULL,
      \`value_type\` VARCHAR(32) NOT NULL DEFAULT 'text',
      \`is_secret\` TINYINT(1) NOT NULL DEFAULT 0,
      \`source\` ENUM('override','migrated') NOT NULL DEFAULT 'override',
      \`updated_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`tenant_id\`, \`skey\`),
      KEY \`idx_tenant_settings_key\` (\`skey\`),
      CONSTRAINT \`fk_tenant_settings_tenant\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_settings_audit\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`setting_key\` VARCHAR(160) NOT NULL,
      \`action\` ENUM('set','clear') NOT NULL,
      \`detail\` JSON DEFAULT NULL,
      \`actor_user_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_tenant_settings_audit_tenant\` (\`tenant_id\`, \`created_at\`),
      CONSTRAINT \`fk_tenant_settings_audit_tenant\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureTenantSettingsSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((error) => {
      ensured = null
      throw error
    })
  }
  return ensured
}

function isSecret(row: TenantSettingRow): boolean {
  return Boolean(row.is_secret) || Boolean(getTenantSettingDefinition(row.skey)?.secret)
}

function decode(row: TenantSettingRow): string | null {
  if (row.svalue == null || row.svalue === "") return null
  if (!isSecret(row)) return String(row.svalue)
  // Canonical secrets use sec:v1. decryptToken is retained for values created
  // by older modules that used the compatible enc:v1 envelope.
  return decryptSecret(String(row.svalue)) ?? decryptToken(String(row.svalue))
}

export async function getTenantSettingRows(tenantId = requireCurrentTenantId()): Promise<TenantSettingRow[]> {
  await ensureTenantSettingsSchema()
  // this read is on the hot path (config resolution runs on nearly
  // every authenticated request). Cache it per OWNING tenant so one tenant can
  // never be served another's settings; setTenantSettings() evicts on write.
  return cachedForTenant("config", tenantId, "setting-rows", () =>
    query<TenantSettingRow[]>(
      "SELECT skey, svalue, value_type, is_secret, updated_at FROM `tenant_settings` WHERE tenant_id = ? ORDER BY skey",
      [tenantId],
    ),
  )
}

/** Returns decrypted values for trusted server-side consumers only. */
export async function getTenantSettingsMap(tenantId = requireCurrentTenantId()): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const row of await getTenantSettingRows(tenantId)) {
    const value = decode(row)
    if (value != null && value !== "") out[row.skey] = value
  }
  return out
}

/** Public projection used by tenant admin forms; secret plaintext never leaves this function. */
export async function getTenantSettingsPublic(tenantId = requireCurrentTenantId()): Promise<{
  values: Record<string, string>
  secretKeys: string[]
  overriddenKeys: string[]
}> {
  const values: Record<string, string> = {}
  const secretKeys: string[] = []
  const overriddenKeys: string[] = []
  for (const row of await getTenantSettingRows(tenantId)) {
    overriddenKeys.push(row.skey)
    if (isSecret(row)) {
      if (row.svalue) values[row.skey] = MASKED_SECRET
      secretKeys.push(row.skey)
    } else {
      values[row.skey] = String(row.svalue ?? "")
    }
  }
  return { values, secretKeys, overriddenKeys }
}

export async function getTenantSettingsAudit(
  limit = 100,
  tenantId = requireCurrentTenantId(),
): Promise<TenantSettingAuditRecord[]> {
  await ensureTenantSettingsSchema()
  const safeLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)))
  return query<TenantSettingAuditRecord[]>(
    `SELECT id, setting_key AS \`key\`, action, actor_user_id, created_at
       FROM \`tenant_settings_audit\`
      WHERE tenant_id = ?
      ORDER BY id DESC LIMIT ${safeLimit}`,
    [tenantId],
  )
}

/**
 * Persist validated tenant overrides. Empty values clear the override and
 * therefore restore the inherited platform/default value.
 */
export async function setTenantSettings(
  entries: Record<string, unknown>,
  actorUserId: number,
  tenantId = requireCurrentTenantId(),
): Promise<{ saved: number; cleared: number; audit: TenantSettingAudit[] }> {
  await ensureTenantSettingsSchema()
  const keys = Object.keys(entries)
  const prepared = keys.map((key) => {
    const result = validateTenantSetting(key, entries[key])
    if (!result.ok) throw new Error(result.error)
    const definition = getTenantSettingDefinition(key)!
    return { key, result, definition }
  })
  for (const item of prepared) {
    if (item.result.value !== "" && item.definition.secret && !isEncryptionConfigured()) {
      throw new Error("SETTINGS_ENCRYPTION_KEY is required before saving secret tenant settings")
    }
  }

  const result = await withTransaction(async (connection) => {
    const existing = keys.length
      ? await transactionQuery<TenantSettingRow[]>(
          connection,
          `SELECT skey, svalue, value_type, is_secret FROM \`tenant_settings\`
           WHERE tenant_id = ? AND skey IN (${keys.map(() => "?").join(",")})`,
          [tenantId, ...keys],
        )
      : []
    const oldByKey = new Map(existing.map((row) => [row.skey, row]))
    const audit: TenantSettingAudit[] = []
    let saved = 0
    let cleared = 0

    for (const item of prepared) {
      const { key, result, definition } = item
      const previous = oldByKey.get(key)
      if (result.value === "") {
        if (previous) {
          await transactionQuery(connection, "DELETE FROM `tenant_settings` WHERE tenant_id = ? AND skey = ?", [tenantId, key])
          await transactionQuery(
            connection,
            "INSERT INTO `tenant_settings_audit` (tenant_id, setting_key, action, detail, actor_user_id) VALUES (?,?,?,?,?)",
            [tenantId, key, "clear", JSON.stringify({ hadPreviousValue: true, hasNewValue: false }), actorUserId],
          )
          cleared++
          audit.push({ key, action: "clear", hadPreviousValue: true, hasNewValue: false })
        }
        continue
      }
      const stored = definition.secret ? encryptSecret(result.value) : result.value
      await transactionQuery(
        connection,
        `INSERT INTO \`tenant_settings\` (tenant_id, skey, svalue, value_type, is_secret, source, updated_by)
         VALUES (?,?,?,?,?,'override',?)
         ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), value_type=VALUES(value_type), is_secret=VALUES(is_secret), source='override', updated_by=VALUES(updated_by)`,
        [tenantId, key, stored, valueType(definition.type), definition.secret ? 1 : 0, actorUserId],
      )
      await transactionQuery(
        connection,
        "INSERT INTO `tenant_settings_audit` (tenant_id, setting_key, action, detail, actor_user_id) VALUES (?,?,?,?,?)",
        [
          tenantId,
          key,
          "set",
          JSON.stringify({ hadPreviousValue: Boolean(previous), hasNewValue: true, secret: definition.secret }),
          actorUserId,
        ],
      )
      saved++
      audit.push({ key, action: "set", hadPreviousValue: Boolean(previous), hasNewValue: true })
    }
    return { saved, cleared, audit }
  })
  // the tenant just changed its settings; drop the cached rows so the
  // very next read reflects the write instead of a stale (up to TTL) snapshot.
  invalidateTenantTarget("config", tenantId)
  return result
}

/** Legacy global values are an inherited baseline during the migration period. */
export async function getLegacyCompanySettings(): Promise<Record<string, string>> {
  const rows = await query<{ skey: string; svalue: string | null }[]>("SELECT skey, svalue FROM company_settings")
  const out: Record<string, string> = {}
  for (const row of rows) if (row.svalue != null && row.svalue !== "") out[row.skey] = row.svalue
  return out
}

export async function getEffectiveTenantSettings(tenantId = requireCurrentTenantId()): Promise<Record<string, string>> {
  const defaults = getSectionDefaults()
  const inherited = await getLegacyCompanySettings().catch(() => ({}))
  const overrides = await getTenantSettingsMap(tenantId).catch(() => ({}))
  return { ...defaults, ...inherited, ...overrides }
}

export async function getTenantSettingValue(key: string, tenantId = requireCurrentTenantId()): Promise<string | null> {
  const rows = await getTenantSettingRows(tenantId)
  const row = rows.find((item) => item.skey === key)
  return row ? decode(row) : null
}

// Kept as a small assertion for callers that want to verify registry wiring.
export function hasConfigDescriptor(key: string): boolean {
  return Boolean(getDescriptor(key) || getTenantSettingDefinition(key))
}
