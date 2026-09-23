import "server-only"
/**
 * Audit log retention (server).
 * ---------------------------------------------------------------------------
 * Persists the platform + tenant retention policies and legal holds, and runs
 * the lifecycle job that seals aged audit entries into an IMMUTABLE archive and
 * (only when a policy opts in, and never while under legal hold) purges the
 * sealed originals from the hot `audit_log_entries` table.
 *
 * Immutable storage architecture
 * ------------------------------
 *   • The hot table (audit_log_entries) stays append-only — enforced by the
 *     BEFORE UPDATE/DELETE triggers in lib/audit-log-store.ts. The ONLY delete
 *     path is this module's purge, which flips a connection-scoped session flag
 *     the trigger checks, so no ordinary code can ever remove a row.
 *   • Each archive batch is a self-contained, gzip-sealed snapshot of a
 *     contiguous id range. Its SHA-256 `content_hash` seals the canonical
 *     payload, and `prev_hash` chains it to the previous batch — any tampering
 *     with an earlier batch breaks the chain and is detectable. The archive
 *     table itself carries append-only triggers too.
 *   • Sealed payloads are stored in the database (authoritative) and, when Blob
 *     storage is configured, also mirrored to an immutable content-addressed
 *     blob for off-database durability.
 *
 * Scope model: aux tables (policies/holds/batches) key everything on a
 * `tenant_id` where a tenant's own id scopes `audit_log_entries.tenant_id = id`
 * and the reserved value 0 scopes the platform-wide rows (tenant_id IS NULL).
 */
import { createHash, randomUUID } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
import { query, withTransaction } from "@/lib/db"
import { ensureAuditSchema, AUDIT_PURGE_SESSION_FLAG, type AuditEntry } from "@/lib/audit-log-store"
import {
  AUDIT_RETENTION_LIMITS,
  DEFAULT_AUDIT_PLATFORM_POLICY,
  clampRetentionDays,
  computeRetentionCutoff,
  isEntryUnderHold,
  normalizeAuditPlatformPolicy,
  normalizeAuditTenantPolicy,
  resolveEffectiveAuditPolicy,
  type AuditLegalHoldFilter,
  type AuditLegalHoldStatus,
  type AuditPlatformPolicy,
  type AuditTenantPolicy,
  type HoldableEntry,
} from "@/lib/audit-retention-policy"

export const PLATFORM_SCOPE = 0 as const

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await ensureAuditSchema()

  await query(`
    CREATE TABLE IF NOT EXISTS \`audit_retention_platform_policy\` (
      \`id\` TINYINT UNSIGNED NOT NULL DEFAULT 1,
      \`default_retention_days\` INT UNSIGNED NOT NULL DEFAULT 2555,
      \`min_retention_days\` INT UNSIGNED NOT NULL DEFAULT 365,
      \`archive_enabled\` TINYINT(1) NOT NULL DEFAULT 1,
      \`purge_after_archive\` TINYINT(1) NOT NULL DEFAULT 0,
      \`updated_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`audit_retention_tenant_policies\` (
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`retention_days\` INT UNSIGNED NOT NULL,
      \`archive_enabled\` TINYINT(1) NOT NULL DEFAULT 1,
      \`purge_after_archive\` TINYINT(1) NOT NULL DEFAULT 0,
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
      \`last_run_at\` DATETIME DEFAULT NULL,
      \`updated_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`audit_retention_legal_holds\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(200) NOT NULL,
      \`reason\` TEXT DEFAULT NULL,
      \`filter_action\` VARCHAR(96) DEFAULT NULL,
      \`filter_entity_type\` VARCHAR(96) DEFAULT NULL,
      \`filter_actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`from_date\` DATETIME DEFAULT NULL,
      \`to_date\` DATETIME DEFAULT NULL,
      \`status\` VARCHAR(12) NOT NULL DEFAULT 'active',
      \`created_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_by_name\` VARCHAR(160) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`released_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`released_by_name\` VARCHAR(160) DEFAULT NULL,
      \`released_at\` DATETIME DEFAULT NULL,
      \`release_reason\` VARCHAR(500) DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_arlh_tenant_status\` (\`tenant_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`audit_log_archive_batches\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`batch_uuid\` CHAR(36) NOT NULL,
      \`from_entry_id\` BIGINT UNSIGNED NOT NULL,
      \`to_entry_id\` BIGINT UNSIGNED NOT NULL,
      \`from_ts\` DATETIME DEFAULT NULL,
      \`to_ts\` DATETIME DEFAULT NULL,
      \`entry_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`payload\` LONGBLOB DEFAULT NULL,
      \`payload_bytes\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`content_hash\` CHAR(64) NOT NULL,
      \`prev_hash\` CHAR(64) DEFAULT NULL,
      \`blob_url\` VARCHAR(1024) DEFAULT NULL,
      \`purged\` TINYINT(1) NOT NULL DEFAULT 0,
      \`purged_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`created_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_arb_uuid\` (\`batch_uuid\`),
      KEY \`idx_arb_tenant\` (\`tenant_id\`, \`to_entry_id\`),
      KEY \`idx_arb_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await ensureArchiveImmutabilityTriggers()
}

/** Append-only guard on the archive table itself: never update, never delete. */
async function ensureArchiveImmutabilityTriggers(): Promise<void> {
  try {
    const existing = (await query(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema = DATABASE()
          AND trigger_name IN ('audit_archive_no_update','audit_archive_no_delete')`,
    )) as { name: string }[]
    const names = new Set(existing.map((r) => String(r.name)))
    if (!names.has("audit_archive_no_update")) {
      await query(
        `CREATE TRIGGER \`audit_archive_no_update\` BEFORE UPDATE ON \`audit_log_archive_batches\`
         FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log_archive_batches is append-only'`,
      )
    }
    if (!names.has("audit_archive_no_delete")) {
      await query(
        `CREATE TRIGGER \`audit_archive_no_delete\` BEFORE DELETE ON \`audit_log_archive_batches\`
         FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log_archive_batches is append-only'`,
      )
    }
  } catch (err) {
    console.warn(
      "[v0] audit archive immutability triggers not installed (app-level immutability still applies):",
      (err as Error).message,
    )
  }
}

export function ensureAuditRetentionSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Scope helper
// ---------------------------------------------------------------------------

/**
 * Map an aux-table scope key to the predicate over `audit_log_entries`.
 * A real tenant id scopes that tenant's rows; PLATFORM_SCOPE (0) scopes the
 * platform-wide rows stored with tenant_id IS NULL.
 */
function entryScopePredicate(scope: number): { sql: string; params: unknown[] } {
  if (scope === PLATFORM_SCOPE) return { sql: "`tenant_id` IS NULL", params: [] }
  return { sql: "`tenant_id` = ?", params: [scope] }
}

// ---------------------------------------------------------------------------
// Platform policy
// ---------------------------------------------------------------------------

export async function getPlatformPolicy(): Promise<AuditPlatformPolicy> {
  await ensureAuditRetentionSchema()
  const rows = (await query(
    `SELECT default_retention_days, min_retention_days, archive_enabled, purge_after_archive
       FROM \`audit_retention_platform_policy\` WHERE id = 1 LIMIT 1`,
  )) as {
    default_retention_days: number
    min_retention_days: number
    archive_enabled: number
    purge_after_archive: number
  }[]
  const row = rows[0]
  if (!row) return { ...DEFAULT_AUDIT_PLATFORM_POLICY }
  return normalizeAuditPlatformPolicy({
    defaultRetentionDays: row.default_retention_days,
    minRetentionDays: row.min_retention_days,
    archiveEnabled: Number(row.archive_enabled) === 1,
    purgeAfterArchive: Number(row.purge_after_archive) === 1,
  })
}

export async function setPlatformPolicy(
  input: Partial<AuditPlatformPolicy>,
  actorUserId: number | null,
): Promise<AuditPlatformPolicy> {
  await ensureAuditRetentionSchema()
  const current = await getPlatformPolicy()
  const next = normalizeAuditPlatformPolicy({ ...current, ...input })
  await query(
    `INSERT INTO \`audit_retention_platform_policy\`
       (id, default_retention_days, min_retention_days, archive_enabled, purge_after_archive, updated_by)
     VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       default_retention_days = VALUES(default_retention_days),
       min_retention_days = VALUES(min_retention_days),
       archive_enabled = VALUES(archive_enabled),
       purge_after_archive = VALUES(purge_after_archive),
       updated_by = VALUES(updated_by)`,
    [next.defaultRetentionDays, next.minRetentionDays, next.archiveEnabled ? 1 : 0, next.purgeAfterArchive ? 1 : 0, actorUserId],
  )
  return next
}

// ---------------------------------------------------------------------------
// Tenant policy
// ---------------------------------------------------------------------------

type TenantPolicyRow = {
  tenant_id: number
  retention_days: number
  archive_enabled: number
  purge_after_archive: number
  enabled: number
  last_run_at: string | null
}

export type ResolvedTenantPolicy = AuditTenantPolicy & {
  tenantId: number
  hasOverride: boolean
  source: "tenant" | "platform"
  lastRunAt: string | null
  platform: AuditPlatformPolicy
}

async function getTenantPolicyRow(tenantId: number): Promise<TenantPolicyRow | null> {
  const rows = (await query(
    `SELECT tenant_id, retention_days, archive_enabled, purge_after_archive, enabled, last_run_at
       FROM \`audit_retention_tenant_policies\` WHERE tenant_id = ? LIMIT 1`,
    [tenantId],
  )) as TenantPolicyRow[]
  return rows[0] ?? null
}

export async function getResolvedTenantPolicy(tenantId: number): Promise<ResolvedTenantPolicy> {
  await ensureAuditRetentionSchema()
  const platform = await getPlatformPolicy()
  const row = await getTenantPolicyRow(tenantId)
  const override = row
    ? {
        retentionDays: row.retention_days,
        archiveEnabled: Number(row.archive_enabled) === 1,
        purgeAfterArchive: Number(row.purge_after_archive) === 1,
        enabled: Number(row.enabled) === 1,
      }
    : null
  const resolved = resolveEffectiveAuditPolicy(override, platform)
  return {
    tenantId,
    retentionDays: resolved.retentionDays,
    archiveEnabled: resolved.archiveEnabled,
    purgeAfterArchive: resolved.purgeAfterArchive,
    enabled: resolved.enabled,
    hasOverride: Boolean(row),
    source: resolved.source,
    lastRunAt: row?.last_run_at ?? null,
    platform,
  }
}

export async function setTenantPolicy(
  tenantId: number,
  input: Partial<AuditTenantPolicy>,
  actorUserId: number | null,
): Promise<ResolvedTenantPolicy> {
  await ensureAuditRetentionSchema()
  const platform = await getPlatformPolicy()
  const current = await getResolvedTenantPolicy(tenantId)
  const next = normalizeAuditTenantPolicy(
    {
      retentionDays: input.retentionDays ?? current.retentionDays,
      archiveEnabled: input.archiveEnabled ?? current.archiveEnabled,
      purgeAfterArchive: input.purgeAfterArchive ?? current.purgeAfterArchive,
      enabled: input.enabled ?? current.enabled,
    },
    platform,
  )
  await query(
    `INSERT INTO \`audit_retention_tenant_policies\`
       (tenant_id, retention_days, archive_enabled, purge_after_archive, enabled, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       retention_days = VALUES(retention_days),
       archive_enabled = VALUES(archive_enabled),
       purge_after_archive = VALUES(purge_after_archive),
       enabled = VALUES(enabled),
       updated_by = VALUES(updated_by)`,
    [tenantId, next.retentionDays, next.archiveEnabled ? 1 : 0, next.purgeAfterArchive ? 1 : 0, next.enabled ? 1 : 0, actorUserId],
  )
  return getResolvedTenantPolicy(tenantId)
}

async function touchTenantLastRun(tenantId: number, at: Date): Promise<void> {
  // Upsert so a scope that has never saved an explicit policy still records runs.
  await query(
    `INSERT INTO \`audit_retention_tenant_policies\` (tenant_id, retention_days, last_run_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_run_at = VALUES(last_run_at)`,
    [tenantId, DEFAULT_AUDIT_PLATFORM_POLICY.defaultRetentionDays, at],
  ).catch(() => {})
}

// ---------------------------------------------------------------------------
// Legal holds
// ---------------------------------------------------------------------------

export type AuditLegalHold = {
  id: number
  tenantId: number
  name: string
  reason: string | null
  filter: AuditLegalHoldFilter
  status: AuditLegalHoldStatus
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  releasedByName: string | null
  releasedAt: string | null
  releaseReason: string | null
}

type LegalHoldRow = {
  id: number
  tenant_id: number
  name: string
  reason: string | null
  filter_action: string | null
  filter_entity_type: string | null
  filter_actor_user_id: number | null
  from_date: string | null
  to_date: string | null
  status: AuditLegalHoldStatus
  created_by: number | null
  created_by_name: string | null
  created_at: string
  released_by_name: string | null
  released_at: string | null
  release_reason: string | null
}

function holdToPublic(row: LegalHoldRow): AuditLegalHold {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    name: row.name,
    reason: row.reason,
    filter: {
      action: row.filter_action,
      entityType: row.filter_entity_type,
      actorUserId: row.filter_actor_user_id,
      fromDate: row.from_date,
      toDate: row.to_date,
    },
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    releasedByName: row.released_by_name,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  }
}

export async function listLegalHolds(scope: number): Promise<AuditLegalHold[]> {
  await ensureAuditRetentionSchema()
  const rows = (await query(
    `SELECT * FROM \`audit_retention_legal_holds\` WHERE tenant_id = ? ORDER BY status ASC, id DESC`,
    [scope],
  )) as LegalHoldRow[]
  return rows.map(holdToPublic)
}

async function listActiveHoldFilters(scope: number): Promise<AuditLegalHoldFilter[]> {
  const rows = (await query(
    `SELECT filter_action, filter_entity_type, filter_actor_user_id, from_date, to_date
       FROM \`audit_retention_legal_holds\` WHERE tenant_id = ? AND status = 'active'`,
    [scope],
  )) as LegalHoldRow[]
  return rows.map((r) => ({
    action: r.filter_action,
    entityType: r.filter_entity_type,
    actorUserId: r.filter_actor_user_id,
    fromDate: r.from_date,
    toDate: r.to_date,
  }))
}

export type CreateLegalHoldInput = {
  name: string
  reason?: string | null
  filter?: AuditLegalHoldFilter
  createdBy?: number | null
  createdByName?: string | null
}

export async function createLegalHold(scope: number, input: CreateLegalHoldInput): Promise<AuditLegalHold> {
  await ensureAuditRetentionSchema()
  const name = String(input.name ?? "").trim()
  if (!name) throw new Error("A legal hold name is required")
  const f = input.filter ?? {}
  const actor = f.actorUserId != null && Number.isFinite(Number(f.actorUserId)) ? Number(f.actorUserId) : null
  const res = (await query(
    `INSERT INTO \`audit_retention_legal_holds\`
       (tenant_id, name, reason, filter_action, filter_entity_type, filter_actor_user_id, from_date, to_date, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope,
      name.slice(0, 200),
      input.reason ? String(input.reason).slice(0, 5000) : null,
      f.action ? String(f.action).slice(0, 96) : null,
      f.entityType ? String(f.entityType).slice(0, 96) : null,
      actor,
      f.fromDate || null,
      f.toDate || null,
      input.createdBy ?? null,
      input.createdByName ? String(input.createdByName).slice(0, 160) : null,
    ],
  )) as { insertId: number }
  const rows = (await query(`SELECT * FROM \`audit_retention_legal_holds\` WHERE id = ? LIMIT 1`, [
    res.insertId,
  ])) as LegalHoldRow[]
  return holdToPublic(rows[0])
}

export async function releaseLegalHold(
  scope: number,
  id: number,
  input: { releasedBy?: number | null; releasedByName?: string | null; reason?: string | null },
): Promise<AuditLegalHold | null> {
  await ensureAuditRetentionSchema()
  await query(
    `UPDATE \`audit_retention_legal_holds\`
        SET status = 'released', released_by = ?, released_by_name = ?, released_at = NOW(), release_reason = ?
      WHERE id = ? AND tenant_id = ? AND status = 'active'`,
    [
      input.releasedBy ?? null,
      input.releasedByName ? String(input.releasedByName).slice(0, 160) : null,
      input.reason ? String(input.reason).slice(0, 500) : null,
      id,
      scope,
    ],
  )
  const rows = (await query(`SELECT * FROM \`audit_retention_legal_holds\` WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    scope,
  ])) as LegalHoldRow[]
  return rows[0] ? holdToPublic(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Archive cursor + sealing
// ---------------------------------------------------------------------------

/** The highest entry id already archived for a scope (0 when none). */
async function getArchiveCursor(scope: number): Promise<number> {
  const rows = (await query(
    `SELECT COALESCE(MAX(to_entry_id), 0) AS cursor FROM \`audit_log_archive_batches\` WHERE tenant_id = ?`,
    [scope],
  )) as { cursor: number }[]
  return Number(rows[0]?.cursor ?? 0)
}

/** The most recent batch's content hash, to chain the next one. */
async function getLastBatchHash(scope: number): Promise<string | null> {
  const rows = (await query(
    `SELECT content_hash FROM \`audit_log_archive_batches\` WHERE tenant_id = ? ORDER BY id DESC LIMIT 1`,
    [scope],
  )) as { content_hash: string }[]
  return rows[0]?.content_hash ?? null
}

function canonicalPayload(entries: AuditEntry[]): string {
  // Stable, id-sorted JSON so the seal is deterministic and reproducible.
  const sorted = [...entries].sort((a, b) => a.id - b.id)
  return JSON.stringify(sorted)
}

export function computeBatchSeal(canonicalJson: string, prevHash: string | null): string {
  return createHash("sha256")
    .update(`${prevHash ?? ""}\n${canonicalJson}`)
    .digest("hex")
}

/** Best-effort mirror of the sealed payload to immutable content-addressed blob. */
async function mirrorToBlob(scope: number, batchUuid: string, gz: Buffer): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null
  try {
    const { put } = await import("@vercel/blob")
    const key = `audit-archive/${scope}/${batchUuid}.json.gz`
    const res = await put(key, gz, {
      access: "public",
      contentType: "application/gzip",
      addRandomSuffix: false,
    })
    return res.url
  } catch (err) {
    console.warn("[v0] audit archive blob mirror failed (DB copy is authoritative):", (err as Error).message)
    return null
  }
}

// ---------------------------------------------------------------------------
// The sweep — archive, then optionally purge
// ---------------------------------------------------------------------------

export type ArchiveSweepResult = {
  scope: number
  dryRun: boolean
  archived: number
  batches: number
  purged: number
  heldSkipped: number
  ranAt: string
  errors: string[]
}

const ARCHIVE_BATCH_SIZE = 1000
const MAX_BATCHES_PER_RUN = 20
const PURGE_SCAN_LIMIT = 5000

type RawEntryRow = Record<string, unknown> & { id: number; created_at: string }

async function fetchEntryRange(
  scope: number,
  afterId: number,
  cutoff: Date,
  limit: number,
): Promise<AuditEntry[]> {
  const pred = entryScopePredicate(scope)
  const rows = (await query(
    `SELECT * FROM \`audit_log_entries\`
      WHERE ${pred.sql} AND id > ? AND created_at <= ?
      ORDER BY id ASC LIMIT ?`,
    [...pred.params, afterId, cutoff, limit],
  )) as RawEntryRow[]
  // Reuse the store's public shape via a light mapping (avoids importing the
  // private mapper). Only the fields we seal/return are needed.
  return rows.map((r) => normalizeRawEntry(r))
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === "object") return v as Record<string, unknown>
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

function normalizeRawEntry(r: RawEntryRow): AuditEntry {
  return {
    id: Number(r.id),
    requestId: (r.request_id as string) ?? null,
    tenantId: r.tenant_id == null ? null : Number(r.tenant_id),
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    actorName: (r.actor_name as string) ?? null,
    actorEmail: (r.actor_email as string) ?? null,
    actorRole: (r.actor_role as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    ipAddress: (r.ip_address as string) ?? null,
    userAgent: (r.user_agent as string) ?? null,
    action: String(r.action),
    entityType: (r.entity_type as string) ?? null,
    entityId: (r.entity_id as string) ?? null,
    entityLabel: (r.entity_label as string) ?? null,
    result: (r.result as AuditEntry["result"]) ?? "success",
    before: parseJson(r.before_data),
    after: parseJson(r.after_data),
    metadata: parseJson(r.metadata),
    integrityHash: (r.integrity_hash as string) ?? null,
    createdAt: String(r.created_at),
  }
}

/**
 * Run the retention lifecycle for a single scope (a tenant id, or PLATFORM_SCOPE
 * for platform-wide rows). Archives every entry past the retention window that
 * has not yet been archived, then — when the policy opts in — purges the sealed
 * originals that are not frozen by an active legal hold.
 */
export async function runArchiveSweep(
  scope: number,
  opts: { dryRun?: boolean; force?: boolean; actorUserId?: number | null } = {},
): Promise<ArchiveSweepResult> {
  await ensureAuditRetentionSchema()
  const now = new Date()
  const errors: string[] = []
  const result: ArchiveSweepResult = {
    scope,
    dryRun: Boolean(opts.dryRun),
    archived: 0,
    batches: 0,
    purged: 0,
    heldSkipped: 0,
    ranAt: now.toISOString(),
    errors,
  }

  // Resolve the governing policy. Platform-wide rows follow the platform policy;
  // tenant rows follow the tenant's resolved policy.
  let retentionDays: number
  let archiveEnabled: boolean
  let purgeAfterArchive: boolean
  let enabled: boolean
  if (scope === PLATFORM_SCOPE) {
    const p = await getPlatformPolicy()
    retentionDays = p.defaultRetentionDays
    archiveEnabled = p.archiveEnabled
    purgeAfterArchive = p.purgeAfterArchive
    enabled = true
  } else {
    const p = await getResolvedTenantPolicy(scope)
    retentionDays = p.retentionDays
    archiveEnabled = p.archiveEnabled
    purgeAfterArchive = p.purgeAfterArchive
    enabled = p.enabled
  }

  if (!enabled && !opts.force) return result
  if (!archiveEnabled && !opts.force) return result

  const cutoff = computeRetentionCutoff(retentionDays, now)

  // --- Archive phase -------------------------------------------------------
  let cursor = await getArchiveCursor(scope)
  let prevHash = await getLastBatchHash(scope)

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const entries = await fetchEntryRange(scope, cursor, cutoff, ARCHIVE_BATCH_SIZE)
    if (entries.length === 0) break

    const fromId = entries[0].id
    const toId = entries[entries.length - 1].id
    const canonical = canonicalPayload(entries)
    const contentHash = computeBatchSeal(canonical, prevHash)

    if (!result.dryRun) {
      try {
        const gz = gzipSync(Buffer.from(canonical, "utf8"))
        const batchUuid = randomUUID()
        const blobUrl = await mirrorToBlob(scope, batchUuid, gz)
        await query(
          `INSERT INTO \`audit_log_archive_batches\`
             (tenant_id, batch_uuid, from_entry_id, to_entry_id, from_ts, to_ts, entry_count,
              payload, payload_bytes, content_hash, prev_hash, blob_url, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            scope,
            batchUuid,
            fromId,
            toId,
            entries[0].createdAt,
            entries[entries.length - 1].createdAt,
            entries.length,
            gz,
            gz.byteLength,
            contentHash,
            prevHash,
            blobUrl,
            opts.actorUserId ?? null,
          ],
        )
      } catch (err) {
        errors.push(`archive batch ${fromId}-${toId}: ${(err as Error).message}`)
        break
      }
    }

    result.archived += entries.length
    result.batches += 1
    cursor = toId
    prevHash = contentHash
    if (entries.length < ARCHIVE_BATCH_SIZE) break
  }

  // --- Purge phase ---------------------------------------------------------
  if (purgeAfterArchive || (opts.force && purgeAfterArchive)) {
    try {
      const purge = await purgeArchivedEntries(scope, cursor, cutoff, Boolean(result.dryRun))
      result.purged = purge.purged
      result.heldSkipped = purge.heldSkipped
    } catch (err) {
      errors.push(`purge: ${(err as Error).message}`)
    }
  }

  if (!result.dryRun) {
    await touchTenantLastRun(scope, now)
  }
  return result
}

/**
 * Delete sealed originals (id <= archivedCursor, created_at <= cutoff) that are
 * NOT frozen by an active legal hold. Idempotent and re-scans up to the cursor,
 * so entries previously skipped for a since-released hold are picked up on a
 * later run. Uses the authorized-purge session flag so the append-only trigger
 * permits exactly these deletes.
 */
async function purgeArchivedEntries(
  scope: number,
  archivedCursor: number,
  cutoff: Date,
  dryRun: boolean,
): Promise<{ purged: number; heldSkipped: number }> {
  if (archivedCursor <= 0) return { purged: 0, heldSkipped: 0 }
  const holds = await listActiveHoldFilters(scope)
  const pred = entryScopePredicate(scope)

  const candidates = (await query(
    `SELECT id, action, entity_type, actor_user_id, created_at
       FROM \`audit_log_entries\`
      WHERE ${pred.sql} AND id <= ? AND created_at <= ?
      ORDER BY id ASC LIMIT ?`,
    [...pred.params, archivedCursor, cutoff, PURGE_SCAN_LIMIT],
  )) as {
    id: number
    action: string
    entity_type: string | null
    actor_user_id: number | null
    created_at: string
  }[]

  const purgeIds: number[] = []
  let heldSkipped = 0
  for (const c of candidates) {
    const entry: HoldableEntry = {
      action: c.action,
      entityType: c.entity_type,
      actorUserId: c.actor_user_id,
      createdAt: c.created_at,
    }
    if (holds.length && isEntryUnderHold(holds, entry)) {
      heldSkipped++
      continue
    }
    purgeIds.push(Number(c.id))
  }

  if (dryRun || purgeIds.length === 0) return { purged: dryRun ? purgeIds.length : 0, heldSkipped }

  // Delete in chunks on a dedicated connection with the authorized-purge flag.
  const CHUNK = 500
  let purged = 0
  for (let i = 0; i < purgeIds.length; i += CHUNK) {
    const chunk = purgeIds.slice(i, i + CHUNK)
    const affected = await withTransaction(async (conn) => {
      try {
        await conn.query(`SET ${AUDIT_PURGE_SESSION_FLAG} = 1`)
        const placeholders = chunk.map(() => "?").join(",")
        const [res] = await conn.query(
          `DELETE FROM \`audit_log_entries\` WHERE id IN (${placeholders})`,
          chunk,
        )
        return Number((res as { affectedRows?: number }).affectedRows ?? 0)
      } finally {
        // Clear the flag before the connection returns to the pool so no other
        // query can ever ride the elevated permission.
        await conn.query(`SET ${AUDIT_PURGE_SESSION_FLAG} = NULL`).catch(() => {})
      }
    })
    purged += affected
  }

  // Record which batches are now purged (best-effort; archive rows are append
  // only so we can't flag them — the purge count lives on the sweep result and
  // audit log instead).
  return { purged, heldSkipped }
}

// ---------------------------------------------------------------------------
// Archive listing + export
// ---------------------------------------------------------------------------

export type ArchiveBatchSummary = {
  id: number
  batchUuid: string
  fromEntryId: number
  toEntryId: number
  fromTs: string | null
  toTs: string | null
  entryCount: number
  payloadBytes: number
  contentHash: string
  prevHash: string | null
  blobUrl: string | null
  createdAt: string
}

export async function listArchiveBatches(scope: number, limit = 100): Promise<ArchiveBatchSummary[]> {
  await ensureAuditRetentionSchema()
  const safe = Math.min(500, Math.max(1, Math.floor(limit)))
  const rows = (await query(
    `SELECT id, batch_uuid, from_entry_id, to_entry_id, from_ts, to_ts, entry_count,
            payload_bytes, content_hash, prev_hash, blob_url, created_at
       FROM \`audit_log_archive_batches\` WHERE tenant_id = ? ORDER BY id DESC LIMIT ${safe}`,
    [scope],
  )) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: Number(r.id),
    batchUuid: String(r.batch_uuid),
    fromEntryId: Number(r.from_entry_id),
    toEntryId: Number(r.to_entry_id),
    fromTs: (r.from_ts as string) ?? null,
    toTs: (r.to_ts as string) ?? null,
    entryCount: Number(r.entry_count),
    payloadBytes: Number(r.payload_bytes),
    contentHash: String(r.content_hash),
    prevHash: (r.prev_hash as string) ?? null,
    blobUrl: (r.blob_url as string) ?? null,
    createdAt: String(r.created_at),
  }))
}

export type ArchiveExport = {
  batch: ArchiveBatchSummary
  entries: AuditEntry[]
  sealValid: boolean
}

/**
 * Retrieve and verify a sealed archive batch, returning its entries. Recomputes
 * the SHA-256 seal from the decompressed payload and compares it to the stored
 * `content_hash` so a caller can prove the archive has not been tampered with.
 */
export async function getArchiveExport(scope: number, batchId: number): Promise<ArchiveExport | null> {
  await ensureAuditRetentionSchema()
  const rows = (await query(
    `SELECT * FROM \`audit_log_archive_batches\` WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [batchId, scope],
  )) as Record<string, unknown>[]
  const row = rows[0]
  if (!row || row.payload == null) return null

  const gz = row.payload as Buffer
  let canonical: string
  try {
    canonical = gunzipSync(gz).toString("utf8")
  } catch {
    return null
  }
  const entries = JSON.parse(canonical) as AuditEntry[]
  const recomputed = computeBatchSeal(canonical, (row.prev_hash as string) ?? null)
  const summary: ArchiveBatchSummary = {
    id: Number(row.id),
    batchUuid: String(row.batch_uuid),
    fromEntryId: Number(row.from_entry_id),
    toEntryId: Number(row.to_entry_id),
    fromTs: (row.from_ts as string) ?? null,
    toTs: (row.to_ts as string) ?? null,
    entryCount: Number(row.entry_count),
    payloadBytes: Number(row.payload_bytes),
    contentHash: String(row.content_hash),
    prevHash: (row.prev_hash as string) ?? null,
    blobUrl: (row.blob_url as string) ?? null,
    createdAt: String(row.created_at),
  }
  return { batch: summary, entries, sealValid: recomputed === summary.contentHash }
}

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export type RetentionSummary = {
  scope: number
  policy: {
    retentionDays: number
    archiveEnabled: boolean
    purgeAfterArchive: boolean
    enabled: boolean
    source: "tenant" | "platform"
    hasOverride: boolean
  }
  platform: AuditPlatformPolicy
  liveEntries: number
  oldestEntryTs: string | null
  eligibleForArchive: number
  archivedBatches: number
  archivedEntries: number
  underHold: number
  activeHolds: number
  lastRunAt: string | null
}

export async function getRetentionSummary(scope: number): Promise<RetentionSummary> {
  await ensureAuditRetentionSchema()
  const now = new Date()

  let policy: RetentionSummary["policy"]
  let platform: AuditPlatformPolicy
  let lastRunAt: string | null
  if (scope === PLATFORM_SCOPE) {
    platform = await getPlatformPolicy()
    policy = {
      retentionDays: platform.defaultRetentionDays,
      archiveEnabled: platform.archiveEnabled,
      purgeAfterArchive: platform.purgeAfterArchive,
      enabled: true,
      source: "platform",
      hasOverride: false,
    }
    const row = await getTenantPolicyRow(PLATFORM_SCOPE)
    lastRunAt = row?.last_run_at ?? null
  } else {
    const resolved = await getResolvedTenantPolicy(scope)
    platform = resolved.platform
    policy = {
      retentionDays: resolved.retentionDays,
      archiveEnabled: resolved.archiveEnabled,
      purgeAfterArchive: resolved.purgeAfterArchive,
      enabled: resolved.enabled,
      source: resolved.source,
      hasOverride: resolved.hasOverride,
    }
    lastRunAt = resolved.lastRunAt
  }

  const cutoff = computeRetentionCutoff(policy.retentionDays, now)
  const pred = entryScopePredicate(scope)

  const liveRows = (await query(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM \`audit_log_entries\` WHERE ${pred.sql}`,
    pred.params,
  )) as { n: number; oldest: string | null }[]
  const eligibleRows = (await query(
    `SELECT COUNT(*) AS n FROM \`audit_log_entries\` WHERE ${pred.sql} AND created_at <= ?`,
    [...pred.params, cutoff],
  )) as { n: number }[]
  const batchRows = (await query(
    `SELECT COUNT(*) AS batches, COALESCE(SUM(entry_count),0) AS entries
       FROM \`audit_log_archive_batches\` WHERE tenant_id = ?`,
    [scope],
  )) as { batches: number; entries: number }[]
  const holdRows = (await query(
    `SELECT COUNT(*) AS n FROM \`audit_retention_legal_holds\` WHERE tenant_id = ? AND status = 'active'`,
    [scope],
  )) as { n: number }[]

  // Count live entries frozen by an active hold (bounded scan).
  const holds = await listActiveHoldFilters(scope)
  let underHold = 0
  if (holds.length) {
    const rows = (await query(
      `SELECT action, entity_type, actor_user_id, created_at
         FROM \`audit_log_entries\` WHERE ${pred.sql} ORDER BY id DESC LIMIT 20000`,
      pred.params,
    )) as { action: string; entity_type: string | null; actor_user_id: number | null; created_at: string }[]
    for (const r of rows) {
      if (isEntryUnderHold(holds, { action: r.action, entityType: r.entity_type, actorUserId: r.actor_user_id, createdAt: r.created_at })) {
        underHold++
      }
    }
  }

  return {
    scope,
    policy,
    platform,
    liveEntries: Number(liveRows[0]?.n ?? 0),
    oldestEntryTs: liveRows[0]?.oldest ?? null,
    eligibleForArchive: Number(eligibleRows[0]?.n ?? 0),
    archivedBatches: Number(batchRows[0]?.batches ?? 0),
    archivedEntries: Number(batchRows[0]?.entries ?? 0),
    underHold,
    activeHolds: Number(holdRows[0]?.n ?? 0),
    lastRunAt,
  }
}

export { AUDIT_RETENTION_LIMITS, clampRetentionDays }
