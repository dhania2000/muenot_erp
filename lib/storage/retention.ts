import "server-only"
import { query } from "@/lib/db"
import { currentTenantId, currentTenantIdOrNull, scopedWhere, tenantInsert, tenantUpdate } from "@/lib/tenant-scope"
import { isFileUnderLegalHold } from "@/lib/legal-hold-store"
import {
  DEFAULT_RETENTION_RULE,
  computeExpiry,
  normalizeRetentionRule,
  resolveRule,
  type RetentionRule,
} from "./retention-policy"
import {
  ensureFileMetadataSchema,
  findRetentionExpired,
  getFileById,
  softDeleteFile,
  type FileObject,
} from "./file-metadata"
import { getActiveConnection } from "./connection-store"
import { VercelBlobProvider } from "./vercel-blob"
import { S3StorageProvider } from "./s3"
import type { StorageProvider } from "./types"

/**
 * Resolve the current tenant's active storage provider WITHOUT importing the
 * storage facade (lib/storage/index.ts), which re-exports this module — pulling
 * it in here would create an import cycle. Mirrors `providerFromConnection`.
 */
async function getTenantProvider(): Promise<StorageProvider> {
  const conn = await getActiveConnection()
  if (conn && conn.provider !== "vercel_blob") return new S3StorageProvider(conn)
  return new VercelBlobProvider()
}

/**
 * Configurable storage retention (server).
 * ---------------------------------------------------------------------------
 * Persists a tenant's retention configuration and runs the automatic cleanup.
 * Two tenant-scoped tables sit on top of the `file_objects` model:
 *
 *   • storage_retention_settings  — one row per tenant: the DEFAULT rule and the
 *                                   auto-cleanup master switch.
 *   • storage_retention_rules     — zero-or-more rows per tenant: a MODULE-specific
 *                                   rule that overrides the default for that module.
 *
 * Per-file concerns already live on `file_objects`:
 * - legal_hold → column; blocks all deletion (never purged).
 *   - retention_expires_at  → the concrete "delete after" timestamp.
 * - retention_override → column added here: when 1 the file's expiry
 *                             was set MANUALLY and policy syncs must leave it alone.
 *
 * The sweep is the integration point that actually deletes bytes + metadata; it
 * is invoked per-tenant by the cron (lib/tenant-scope forEachActiveTenant) and
 * on demand from the admin UI.
 */

const SETTINGS_TABLE = "storage_retention_settings"
const RULES_TABLE = "storage_retention_rules"

// ---------------------------------------------------------------------------
// Schema (self-healing, tenant-scoped)
// ---------------------------------------------------------------------------

let schemaEnsured: Promise<void> | null = null

export function ensureRetentionSchema(): Promise<void> {
  if (!schemaEnsured) schemaEnsured = doEnsure()
  return schemaEnsured
}

async function doEnsure(): Promise<void> {
  await ensureFileMetadataSchema()

  await query(`
    CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      default_mode VARCHAR(12) NOT NULL DEFAULT 'duration',
      default_amount INT UNSIGNED NOT NULL DEFAULT 7,
      default_unit VARCHAR(8) NOT NULL DEFAULT 'years',
      auto_cleanup_enabled TINYINT(1) NOT NULL DEFAULT 0,
      last_run_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_srs_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS ${RULES_TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      module VARCHAR(60) NOT NULL,
      mode VARCHAR(12) NOT NULL DEFAULT 'duration',
      amount INT UNSIGNED NOT NULL DEFAULT 7,
      unit VARCHAR(8) NOT NULL DEFAULT 'years',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_srr_tenant_module (tenant_id, module),
      KEY idx_srr_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // mark files whose retention was set by hand so policy syncs skip them.
  await ensureFileObjectsOverrideColumn()
}

/** Add `retention_override` to `file_objects` once, ignoring "already exists". */
async function ensureFileObjectsOverrideColumn(): Promise<void> {
  try {
    const cols = await query<{ Field: string }[]>(`SHOW COLUMNS FROM file_objects LIKE 'retention_override'`)
    if (cols.length === 0) {
      await query(`ALTER TABLE file_objects ADD COLUMN retention_override TINYINT(1) NOT NULL DEFAULT 0`)
    }
  } catch (err) {
    console.error("[v0] retention_override column ensure failed:", err)
  }
}

// ---------------------------------------------------------------------------
// Settings (default rule + auto-cleanup switch)
// ---------------------------------------------------------------------------

export type RetentionSettings = {
  defaultRule: RetentionRule
  autoCleanupEnabled: boolean
  lastRunAt: string | null
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  defaultRule: { ...DEFAULT_RETENTION_RULE },
  autoCleanupEnabled: false,
  lastRunAt: null,
}

type SettingsRow = {
  id: number
  default_mode: string
  default_amount: number
  default_unit: string
  auto_cleanup_enabled: number
  last_run_at: string | null
}

export async function getRetentionSettings(): Promise<RetentionSettings> {
  await ensureRetentionSchema()
  const { where, params } = scopedWhere(SETTINGS_TABLE, "", [])
  const rows = await query<SettingsRow[]>(`SELECT * FROM ${SETTINGS_TABLE} ${where} LIMIT 1`, params)
  const row = rows[0]
  if (!row) return { ...DEFAULT_RETENTION_SETTINGS, defaultRule: { ...DEFAULT_RETENTION_RULE } }
  return {
    defaultRule: normalizeRetentionRule({
      mode: row.default_mode,
      amount: row.default_amount,
      unit: row.default_unit,
    }),
    autoCleanupEnabled: Number(row.auto_cleanup_enabled) === 1,
    lastRunAt: row.last_run_at,
  }
}

export type RetentionSettingsInput = {
  defaultRule?: RetentionRule
  autoCleanupEnabled?: boolean
}

export async function setRetentionSettings(input: RetentionSettingsInput): Promise<RetentionSettings> {
  await ensureRetentionSchema()
  const current = await getRetentionSettings()
  const next: RetentionSettings = {
    defaultRule: input.defaultRule ? normalizeRetentionRule(input.defaultRule) : current.defaultRule,
    autoCleanupEnabled:
      input.autoCleanupEnabled !== undefined ? input.autoCleanupEnabled : current.autoCleanupEnabled,
    lastRunAt: current.lastRunAt,
  }

  const { where, params } = scopedWhere(SETTINGS_TABLE, "", [])
  const existing = await query<{ id: number }[]>(`SELECT id FROM ${SETTINGS_TABLE} ${where} LIMIT 1`, params)
  const values = {
    default_mode: next.defaultRule.mode,
    default_amount: next.defaultRule.amount,
    default_unit: next.defaultRule.unit,
    auto_cleanup_enabled: next.autoCleanupEnabled ? 1 : 0,
  }
  if (existing[0]) {
    await tenantUpdate(SETTINGS_TABLE, values, "id = ?", [existing[0].id])
  } else {
    await tenantInsert(SETTINGS_TABLE, values)
  }
  return next
}

async function touchLastRun(at: Date): Promise<void> {
  const { where, params } = scopedWhere(SETTINGS_TABLE, "", [])
  const existing = await query<{ id: number }[]>(`SELECT id FROM ${SETTINGS_TABLE} ${where} LIMIT 1`, params)
  if (existing[0]) {
    await tenantUpdate(SETTINGS_TABLE, { last_run_at: at }, "id = ?", [existing[0].id])
  }
}

// ---------------------------------------------------------------------------
// Module-specific rules
// ---------------------------------------------------------------------------

export type ModuleRetentionRule = { module: string; rule: RetentionRule }

type RuleRow = { module: string; mode: string; amount: number; unit: string }

export async function listModuleRules(): Promise<ModuleRetentionRule[]> {
  await ensureRetentionSchema()
  const { where, params } = scopedWhere(RULES_TABLE, "", [])
  const rows = await query<RuleRow[]>(`SELECT * FROM ${RULES_TABLE} ${where} ORDER BY module ASC`, params)
  return rows.map((r) => ({
    module: r.module,
    rule: normalizeRetentionRule({ mode: r.mode, amount: r.amount, unit: r.unit }),
  }))
}

function normalizeModuleName(value: string): string {
  return String(value ?? "").trim().slice(0, 60)
}

/** Create/replace a module override, or clear it when `rule` is null. */
export async function setModuleRule(module: string, rule: RetentionRule | null): Promise<void> {
  await ensureRetentionSchema()
  const mod = normalizeModuleName(module)
  if (!mod) throw new Error("Module is required")

  if (rule === null) {
    const { where, params } = scopedWhere(RULES_TABLE, "module = ?", [mod])
    await query(`DELETE FROM ${RULES_TABLE} ${where}`, params)
    return
  }

  const normalized = normalizeRetentionRule(rule)
  const { where, params } = scopedWhere(RULES_TABLE, "module = ?", [mod])
  const existing = await query<{ id: number }[]>(`SELECT id FROM ${RULES_TABLE} ${where} LIMIT 1`, params)
  const values = { module: mod, mode: normalized.mode, amount: normalized.amount, unit: normalized.unit }
  if (existing[0]) {
    await tenantUpdate(RULES_TABLE, values, "id = ?", [existing[0].id])
  } else {
    await tenantInsert(RULES_TABLE, values)
  }
}

/** The effective rule for a module: its override if present, else the default. */
export async function resolveModuleRule(module: string): Promise<RetentionRule> {
  const [settings, rules] = await Promise.all([getRetentionSettings(), listModuleRules()])
  const override = rules.find((r) => r.module === normalizeModuleName(module))?.rule ?? null
  return resolveRule(settings.defaultRule, override)
}

// ---------------------------------------------------------------------------
// Per-file manual override + legal hold
// ---------------------------------------------------------------------------

export type FileRetentionInput =
  | { mode: "permanent" }
  | { mode: "duration"; amount: number; unit: RetentionRule["unit"] }
  | { expiresAt: string | Date | null }

/**
 * Manually set a single file's retention (extend, shorten, make permanent, or
 * pin an explicit date). Marks the file as an override so future policy syncs
 * leave it untouched. Anchors durations at the file's created_at.
 */
export async function setFileRetention(fileId: number, input: FileRetentionInput): Promise<FileObject | null> {
  await ensureRetentionSchema()
  const file = await getFileById(fileId)
  if (!file) return null

  let expiresAt: Date | null
  if ("expiresAt" in input) {
    if (input.expiresAt == null) {
      expiresAt = null
    } else {
      const d = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)
      if (Number.isNaN(d.getTime())) throw new Error("Invalid expiry date")
      expiresAt = d
    }
  } else {
    const anchor = file.createdAt ? new Date(file.createdAt) : new Date()
    expiresAt =
      input.mode === "permanent"
        ? null
        : computeExpiry({ mode: "duration", amount: input.amount, unit: input.unit }, anchor)
  }

  await tenantUpdate(
    "file_objects",
    { retention_expires_at: expiresAt, retention_override: 1 },
    "id = ?",
    [fileId],
  )
  return getFileById(fileId)
}

/** Clear a manual override so the file follows its module/default policy again. */
export async function clearFileRetentionOverride(fileId: number): Promise<FileObject | null> {
  await ensureRetentionSchema()
  const file = await getFileById(fileId)
  if (!file) return null
  const rule = await resolveModuleRule(file.module)
  const anchor = file.createdAt ? new Date(file.createdAt) : new Date()
  const expiresAt = computeExpiry(rule, anchor)
  await tenantUpdate(
    "file_objects",
    { retention_expires_at: expiresAt, retention_override: 0 },
    "id = ?",
    [fileId],
  )
  return getFileById(fileId)
}

// ---------------------------------------------------------------------------
// Policy sync (re-stamp expiry for non-override, non-hold files)
// ---------------------------------------------------------------------------

/**
 * Recompute `retention_expires_at` for the tenant's live files from the current
 * module/default policy, anchored at each file's created_at. Skips files under
 * legal hold and files with a manual override. This makes a policy change take
 * effect on existing files, not just new uploads.
 */
export async function syncRetentionExpiry(limit = 1000): Promise<{ updated: number }> {
  await ensureRetentionSchema()
  const settings = await getRetentionSettings()
  const rules = await listModuleRules()
  const ruleByModule = new Map(rules.map((r) => [r.module, r.rule]))

  const { where, params } = scopedWhere(
    "file_objects",
    "upload_status = 'completed' AND legal_hold = 0 AND retention_override = 0",
    [],
  )
  const rows = await query<{ id: number; module: string; created_at: string | null }[]>(
    `SELECT id, module, created_at FROM file_objects ${where} ORDER BY id DESC LIMIT ?`,
    [...params, Math.max(1, Math.min(5000, limit))],
  )

  let updated = 0
  for (const row of rows) {
    const rule = resolveRule(settings.defaultRule, ruleByModule.get(row.module) ?? null)
    const anchor = row.created_at ? new Date(row.created_at) : new Date()
    const expiresAt = computeExpiry(rule, anchor)
    await tenantUpdate("file_objects", { retention_expires_at: expiresAt }, "id = ? AND retention_override = 0", [
      row.id,
    ])
    updated++
  }
  return { updated }
}

// ---------------------------------------------------------------------------
// The sweep — automatic cleanup (Phase 2/3 integration point)
// ---------------------------------------------------------------------------

export type RetentionSweepResult = {
  scanned: number
  deleted: number
  skippedLegalHold: number
  failed: number
  dryRun: boolean
  ranAt: string
  errors: string[]
}

/**
 * Delete every file whose retention window has elapsed for the CURRENT tenant.
 * Files under a legal hold are never deleted (double-guarded: `findRetentionExpired`
 * excludes them, and the physical delete re-checks). When `dryRun` is true it
 * reports what WOULD be deleted without touching storage or metadata.
 */
export async function runRetentionSweep(
  opts: { dryRun?: boolean; force?: boolean; sync?: boolean; limit?: number } = {},
): Promise<RetentionSweepResult> {
  await ensureRetentionSchema()
  const now = new Date()
  const errors: string[] = []
  const result: RetentionSweepResult = {
    scanned: 0,
    deleted: 0,
    skippedLegalHold: 0,
    failed: 0,
    dryRun: Boolean(opts.dryRun),
    ranAt: now.toISOString(),
    errors,
  }

  const settings = await getRetentionSettings()
  // A cron run only proceeds when auto-cleanup is on; a `force` (manual) run
  // ignores the switch so an admin can purge on demand.
  if (!settings.autoCleanupEnabled && !opts.force && !opts.dryRun) {
    return result
  }

  // Keep existing files aligned with the current policy before selecting.
  if (opts.sync !== false) {
    try {
      await syncRetentionExpiry()
    } catch (err) {
      errors.push(`sync failed: ${(err as Error).message}`)
    }
  }

  const expired = await findRetentionExpired(now, opts.limit ?? 200)
  result.scanned = expired.length

  const provider = await getTenantProvider()
  const tenantId = currentTenantIdOrNull()

  for (const file of expired) {
    // Defense in depth: never delete anything on legal hold. Two independent
    // guards: the per-file `legal_hold` column, and a governance
    // legal hold that covers this file directly or via its module.
    if (file.legalHold) {
      result.skippedLegalHold++
      continue
    }
    const governanceHold = await isFileUnderLegalHold(tenantId, { id: file.id, module: file.module })
    if (governanceHold.held) {
      result.skippedLegalHold++
      continue
    }
    if (result.dryRun) {
      result.deleted++
      continue
    }
    try {
      await provider.delete(file.objectKey)
      await softDeleteFile(file.id)
      result.deleted++
    } catch (err) {
      result.failed++
      errors.push(`file ${file.id}: ${(err as Error).message}`)
    }
  }

  if (!result.dryRun) {
    await touchLastRun(now).catch(() => {})
  }
  return result
}

// ---------------------------------------------------------------------------
// Dashboard summary for the admin UI
// ---------------------------------------------------------------------------

export type RetentionSummary = {
  settings: RetentionSettings
  moduleRules: ModuleRetentionRule[]
  totalFiles: number
  onLegalHold: number
  overridden: number
  permanent: number
  expiringSoon: number
  expired: number
}

/** Everything the retention admin panel needs in one resolved read. */
export async function getRetentionSummary(): Promise<RetentionSummary> {
  await ensureRetentionSchema()
  const [settings, moduleRules] = await Promise.all([getRetentionSettings(), listModuleRules()])

  const soon = new Date(Date.now() + 30 * 86_400_000)
  const { where, params } = scopedWhere("file_objects", "upload_status = 'completed' AND is_current = 1", [])
  const rows = await query<
    { total: number; hold: number; overridden: number; permanent: number; soon: number; expired: number }[]
  >(
    `SELECT
       COUNT(*) AS total,
       SUM(legal_hold = 1) AS hold,
       SUM(retention_override = 1) AS overridden,
       SUM(retention_expires_at IS NULL) AS permanent,
       SUM(legal_hold = 0 AND retention_expires_at IS NOT NULL AND retention_expires_at > ? AND retention_expires_at <= ?) AS soon,
       SUM(legal_hold = 0 AND retention_expires_at IS NOT NULL AND retention_expires_at <= ?) AS expired
     FROM file_objects ${where}`,
    [new Date(), soon, new Date(), ...params],
  )
  const r = rows[0] ?? ({} as any)
  return {
    settings,
    moduleRules,
    totalFiles: Number(r.total ?? 0),
    onLegalHold: Number(r.hold ?? 0),
    overridden: Number(r.overridden ?? 0),
    permanent: Number(r.permanent ?? 0),
    expiringSoon: Number(r.soon ?? 0),
    expired: Number(r.expired ?? 0),
  }
}
