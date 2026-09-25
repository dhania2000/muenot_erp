import "server-only"

import { query, withTransaction } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { getMaster, upsertMaster } from "@/lib/master-data/service"
import type { MasterRow } from "@/lib/master-data/types"
import {
  advanceCursor,
  backoffSeconds,
  classifyChange,
  clampPageSize,
  decodeCursor,
  emptyCursor,
  encodeCursor,
  fingerprintNormalized,
  isStaleCursor,
  isValidResolution,
  type ConflictResolution,
  type Cursor,
  type NormalizedRecord,
  type ProviderRecord,
  recordEventKey,
  resolveConflict,
  runIdempotencyKey,
  shouldRetry,
  summarizeRunStatus,
  SYNC_LIMITS,
  SyncError,
  type RunStatus,
  type SyncBaseline,
  type SyncMode,
} from "@/lib/integration-sync/model"
import { getSyncSource, isKnownSource, type PageFetcher, requireSyncSource, resolveFetcher } from "@/lib/integration-sync/providers"

/**
 * Spec16 — Integration sync & conflict resolution: persistence + engine (#90-91).
 * ---------------------------------------------------------------------------
 * Every read and write below is TENANT-SCOPED: the tenant id comes from the
 * verified guard (the caller passes it after requireModuleAction), never from a
 * request body, and every statement carries a `tenant_id` predicate so the
 * fail-closed data guard (lib/tenant-guard.ts) is satisfied and cross-tenant
 * access is impossible by construction.
 *
 * The engine implements:
 *   - INITIAL + INCREMENTAL sync driven by opaque cursors with per-page
 *     CHECKPOINTS persisted on the run row, so a crashed/timed-out run resumes
 *     without reprocessing completed pages;
 *   - bounded RETRY with exponential backoff on provider OUTAGE;
 *   - STALE-CURSOR detection that safely restarts from the connection baseline
 *     instead of skipping a window;
 *   - three-way CONFLICT detection (external vs ERP vs baseline) surfaced as
 *     resolvable conflict rows (ERP-wins / external-wins / manual merge);
 *   - an IMMUTABLE, append-only sync log keyed so REPLAY of a run applies each
 *     record at-most-once (no duplicate master rows), backed by idempotent
 *     master upserts.
 */

// ---------------------------------------------------------------------------
// Time helpers (DATETIME columns hold UTC; pool returns strings)
// ---------------------------------------------------------------------------

function toSqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ")
}
function fromSqlUtc(value: unknown): string | null {
  if (!value) return null
  const text = String(value)
  return /Z$|[+-]\d\d:\d\d$/.test(text)
    ? new Date(text).toISOString()
    : new Date(`${text.replace(" ", "T")}Z`).toISOString()
}
function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Public row types
// ---------------------------------------------------------------------------

export type SyncConnection = {
  id: number
  tenantId: number
  providerKey: string
  entityKind: string
  masterKind: string
  label: string
  enabled: boolean
  cronExpression: string | null
  config: Record<string, unknown>
  cursorPosition: string | null
  generation: number
  status: "idle" | "syncing" | "error"
  lastError: string | null
  lastRunId: number | null
  lastSyncedAt: string | null
  nextRunAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type SyncRun = {
  id: number
  tenantId: number
  connectionId: number
  mode: SyncMode
  status: RunStatus
  attempts: number
  maxAttempts: number
  pages: number
  fetched: number
  applied: number
  skipped: number
  conflicts: number
  errors: number
  checkpointCursor: string | null
  nextRetryAt: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type SyncConflict = {
  id: number
  tenantId: number
  connectionId: number
  externalId: string
  masterKind: string
  code: string
  status: "open" | "resolved"
  resolution: ConflictResolution | null
  externalRecord: NormalizedRecord | null
  localRecord: NormalizedRecord | null
  resolvedBy: number | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
}

export class SyncConnectionNotFound extends Error {}
export class SyncConflictNotFound extends Error {}
export class SyncConflictAlreadyResolved extends Error {}
export class SyncVersionConflict extends Error {}

// ---------------------------------------------------------------------------
// Schema (self-heal; migration is the authoritative source of record)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null
async function runEnsure() {
  await query(`CREATE TABLE IF NOT EXISTS integration_sync_connections (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    provider_key VARCHAR(64) NOT NULL,
    entity_kind VARCHAR(64) NOT NULL,
    master_kind VARCHAR(64) NOT NULL,
    label VARCHAR(160) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    cron_expression VARCHAR(120) NULL,
    config JSON NULL,
    cursor_position VARCHAR(500) NULL,
    generation INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('idle','syncing','error') NOT NULL DEFAULT 'idle',
    last_error VARCHAR(500) NULL,
    last_run_id BIGINT UNSIGNED NULL,
    last_synced_at DATETIME NULL,
    next_run_at DATETIME NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    created_by BIGINT UNSIGNED NULL,
    updated_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_sync_conn (tenant_id, provider_key, entity_kind),
    KEY idx_sync_conn_due (enabled, status, next_run_at),
    KEY idx_sync_conn_tenant (tenant_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS integration_sync_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    connection_id BIGINT UNSIGNED NOT NULL,
    mode ENUM('initial','incremental') NOT NULL,
    status ENUM('pending','running','succeeded','failed','partial') NOT NULL DEFAULT 'pending',
    idempotency_key VARCHAR(191) NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
    pages INT UNSIGNED NOT NULL DEFAULT 0,
    fetched INT UNSIGNED NOT NULL DEFAULT 0,
    applied INT UNSIGNED NOT NULL DEFAULT 0,
    skipped INT UNSIGNED NOT NULL DEFAULT 0,
    conflicts INT UNSIGNED NOT NULL DEFAULT 0,
    errors INT UNSIGNED NOT NULL DEFAULT 0,
    checkpoint_cursor VARCHAR(500) NULL,
    next_retry_at DATETIME NULL,
    error_message TEXT NULL,
    triggered_by BIGINT UNSIGNED NULL,
    trigger_source ENUM('manual','scheduler') NOT NULL DEFAULT 'manual',
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_sync_run_idem (tenant_id, idempotency_key),
    KEY idx_sync_run_conn (tenant_id, connection_id, created_at),
    KEY idx_sync_run_retry (status, next_retry_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS integration_record_mappings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    connection_id BIGINT UNSIGNED NOT NULL,
    external_id VARCHAR(191) NOT NULL,
    master_kind VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    external_fingerprint VARCHAR(32) NULL,
    local_fingerprint VARCHAR(32) NULL,
    status ENUM('active','conflict','archived') NOT NULL DEFAULT 'active',
    last_synced_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_mapping_ext (tenant_id, connection_id, external_id),
    KEY idx_mapping_code (tenant_id, connection_id, code),
    KEY idx_mapping_status (tenant_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS integration_sync_conflicts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    connection_id BIGINT UNSIGNED NOT NULL,
    external_id VARCHAR(191) NOT NULL,
    master_kind VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    status ENUM('open','resolved') NOT NULL DEFAULT 'open',
    resolution ENUM('erp_wins','external_wins','manual') NULL,
    external_record JSON NULL,
    local_record JSON NULL,
    detected_run_id BIGINT UNSIGNED NULL,
    resolved_by BIGINT UNSIGNED NULL,
    resolved_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_conflict_open (tenant_id, connection_id, external_id, status),
    KEY idx_conflict_tenant (tenant_id, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS integration_sync_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    connection_id BIGINT UNSIGNED NOT NULL,
    run_id BIGINT UNSIGNED NULL,
    event_key VARCHAR(191) NOT NULL,
    external_id VARCHAR(191) NOT NULL,
    action VARCHAR(32) NOT NULL,
    detail JSON NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uniq_log_event (tenant_id, connection_id, event_key),
    KEY idx_log_run (tenant_id, run_id, id),
    KEY idx_log_ext (tenant_id, connection_id, external_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}
export function ensureIntegrationSyncSchema() {
  if (!ensured) ensured = runEnsure().catch((error) => { ensured = null; throw error })
  return ensured
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapConnection(row: any): SyncConnection {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    providerKey: row.provider_key,
    entityKind: row.entity_kind,
    masterKind: row.master_kind,
    label: row.label,
    enabled: Boolean(row.enabled),
    cronExpression: row.cron_expression ?? null,
    config: json<Record<string, unknown>>(row.config, {}),
    cursorPosition: row.cursor_position ?? null,
    generation: Number(row.generation ?? 0),
    status: row.status,
    lastError: row.last_error ?? null,
    lastRunId: row.last_run_id == null ? null : Number(row.last_run_id),
    lastSyncedAt: fromSqlUtc(row.last_synced_at),
    nextRunAt: fromSqlUtc(row.next_run_at),
    version: Number(row.version),
    createdAt: fromSqlUtc(row.created_at) ?? "",
    updatedAt: fromSqlUtc(row.updated_at) ?? "",
  }
}

function mapRun(row: any): SyncRun {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    connectionId: Number(row.connection_id),
    mode: row.mode,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    pages: Number(row.pages),
    fetched: Number(row.fetched),
    applied: Number(row.applied),
    skipped: Number(row.skipped),
    conflicts: Number(row.conflicts),
    errors: Number(row.errors),
    checkpointCursor: row.checkpoint_cursor ?? null,
    nextRetryAt: fromSqlUtc(row.next_retry_at),
    errorMessage: row.error_message ?? null,
    startedAt: fromSqlUtc(row.started_at),
    finishedAt: fromSqlUtc(row.finished_at),
    createdAt: fromSqlUtc(row.created_at) ?? "",
  }
}

function mapConflict(row: any): SyncConflict {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    connectionId: Number(row.connection_id),
    externalId: row.external_id,
    masterKind: row.master_kind,
    code: row.code,
    status: row.status,
    resolution: row.resolution ?? null,
    externalRecord: json<NormalizedRecord | null>(row.external_record, null),
    localRecord: json<NormalizedRecord | null>(row.local_record, null),
    resolvedBy: row.resolved_by == null ? null : Number(row.resolved_by),
    resolvedAt: fromSqlUtc(row.resolved_at),
    createdAt: fromSqlUtc(row.created_at) ?? "",
    updatedAt: fromSqlUtc(row.updated_at) ?? "",
  }
}

// ---------------------------------------------------------------------------
// Connection CRUD (tenant-scoped)
// ---------------------------------------------------------------------------

export type ConnectionInput = {
  providerKey: string
  entityKind: string
  label?: string
  enabled?: boolean
  cronExpression?: string | null
  config?: Record<string, unknown>
}

export async function listSyncConnections(tenantId: number): Promise<SyncConnection[]> {
  await ensureIntegrationSyncSchema()
  const rows = await query<any[]>(
    "SELECT * FROM integration_sync_connections WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200",
    [tenantId],
  )
  return rows.map(mapConnection)
}

export async function getSyncConnection(tenantId: number, id: number): Promise<SyncConnection | null> {
  await ensureIntegrationSyncSchema()
  const rows = await query<any[]>(
    "SELECT * FROM integration_sync_connections WHERE tenant_id=? AND id=? LIMIT 1",
    [tenantId, id],
  )
  return rows[0] ? mapConnection(rows[0]) : null
}

export async function createSyncConnection(
  tenantId: number,
  actorId: number,
  input: ConnectionInput,
): Promise<SyncConnection> {
  await ensureIntegrationSyncSchema()
  const source = requireSyncSource(input.providerKey, input.entityKind)
  const label = (input.label?.trim() || source.label).slice(0, 160)
  try {
    const res = await query<any>(
      `INSERT INTO integration_sync_connections
        (tenant_id, provider_key, entity_kind, master_kind, label, enabled, cron_expression, config, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        tenantId,
        source.providerKey,
        source.entityKind,
        source.masterKind,
        label,
        input.enabled === false ? 0 : 1,
        input.cronExpression?.trim() || null,
        JSON.stringify(input.config ?? {}),
        actorId,
        actorId,
      ],
    )
    const created = (await getSyncConnection(tenantId, Number(res.insertId)))!
    await recordAuditLog({
      action: "integration_sync.connection.create",
      entityType: "integration_sync_connection",
      entityId: created.id,
      entityLabel: created.label,
      after: { providerKey: created.providerKey, entityKind: created.entityKind, masterKind: created.masterKind },
    })
    return created
  } catch (error: any) {
    if (error?.code === "ER_DUP_ENTRY") {
      throw new SyncVersionConflict("A sync connection for this provider and entity already exists")
    }
    throw error
  }
}

export async function updateSyncConnection(
  tenantId: number,
  actorId: number,
  id: number,
  patch: { label?: string; enabled?: boolean; cronExpression?: string | null; config?: Record<string, unknown> },
  expectedVersion: number,
): Promise<SyncConnection> {
  await ensureIntegrationSyncSchema()
  const current = await getSyncConnection(tenantId, id)
  if (!current) throw new SyncConnectionNotFound("Sync connection not found")
  const res = await query<any>(
    `UPDATE integration_sync_connections
       SET label=?, enabled=?, cron_expression=?, config=?, updated_by=?, version=version+1
     WHERE tenant_id=? AND id=? AND version=?`,
    [
      (patch.label?.trim() || current.label).slice(0, 160),
      patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      patch.cronExpression === undefined ? current.cronExpression : patch.cronExpression?.trim() || null,
      JSON.stringify(patch.config ?? current.config),
      actorId,
      tenantId,
      id,
      expectedVersion,
    ],
  )
  if (Number(res.affectedRows) !== 1) {
    throw new SyncVersionConflict("This connection was changed by someone else. Refresh and try again.")
  }
  await recordAuditLog({
    action: "integration_sync.connection.update",
    entityType: "integration_sync_connection",
    entityId: id,
    before: { enabled: current.enabled, cronExpression: current.cronExpression },
    after: { enabled: patch.enabled ?? current.enabled },
  })
  return (await getSyncConnection(tenantId, id))!
}

/**
 * Reset a connection's baseline: bump the generation (invalidating any in-flight
 * cursor as STALE) and clear the stored position so the next run performs a full
 * initial sync from scratch. Mappings/log are retained for audit and replay
 * safety.
 */
export async function resetSyncBaseline(tenantId: number, actorId: number, id: number): Promise<SyncConnection> {
  await ensureIntegrationSyncSchema()
  const res = await query<any>(
    `UPDATE integration_sync_connections
       SET generation=generation+1, cursor_position=NULL, status='idle', last_error=NULL, updated_by=?, version=version+1
     WHERE tenant_id=? AND id=?`,
    [actorId, tenantId, id],
  )
  if (Number(res.affectedRows) !== 1) throw new SyncConnectionNotFound("Sync connection not found")
  await recordAuditLog({
    action: "integration_sync.connection.reset_baseline",
    entityType: "integration_sync_connection",
    entityId: id,
  })
  return (await getSyncConnection(tenantId, id))!
}

// ---------------------------------------------------------------------------
// Runs + conflicts reads (tenant-scoped)
// ---------------------------------------------------------------------------

export async function listSyncRuns(tenantId: number, connectionId: number, limit = 50): Promise<SyncRun[]> {
  await ensureIntegrationSyncSchema()
  const bounded = Math.min(200, Math.max(1, Math.floor(limit)))
  const rows = await query<any[]>(
    `SELECT * FROM integration_sync_runs WHERE tenant_id=? AND connection_id=? ORDER BY id DESC LIMIT ${bounded}`,
    [tenantId, connectionId],
  )
  return rows.map(mapRun)
}

export async function getSyncRun(tenantId: number, id: number): Promise<SyncRun | null> {
  await ensureIntegrationSyncSchema()
  const rows = await query<any[]>("SELECT * FROM integration_sync_runs WHERE tenant_id=? AND id=? LIMIT 1", [tenantId, id])
  return rows[0] ? mapRun(rows[0]) : null
}

export async function listSyncConflicts(
  tenantId: number,
  opts: { connectionId?: number; status?: "open" | "resolved"; limit?: number } = {},
): Promise<SyncConflict[]> {
  await ensureIntegrationSyncSchema()
  const bounded = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 100)))
  const where: string[] = ["tenant_id=?"]
  const params: any[] = [tenantId]
  if (opts.connectionId != null) {
    where.push("connection_id=?")
    params.push(opts.connectionId)
  }
  if (opts.status) {
    where.push("status=?")
    params.push(opts.status)
  }
  const rows = await query<any[]>(
    `SELECT * FROM integration_sync_conflicts WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${bounded}`,
    params,
  )
  return rows.map(mapConflict)
}

export async function getSyncConflict(tenantId: number, id: number): Promise<SyncConflict | null> {
  await ensureIntegrationSyncSchema()
  const rows = await query<any[]>("SELECT * FROM integration_sync_conflicts WHERE tenant_id=? AND id=? LIMIT 1", [tenantId, id])
  return rows[0] ? mapConflict(rows[0]) : null
}

export async function listSyncLog(
  tenantId: number,
  connectionId: number,
  opts: { runId?: number; limit?: number } = {},
): Promise<Array<{ id: number; runId: number | null; eventKey: string; externalId: string; action: string; detail: Record<string, unknown> | null; createdAt: string }>> {
  await ensureIntegrationSyncSchema()
  const bounded = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 200)))
  const where: string[] = ["tenant_id=?", "connection_id=?"]
  const params: any[] = [tenantId, connectionId]
  if (opts.runId != null) {
    where.push("run_id=?")
    params.push(opts.runId)
  }
  const rows = await query<any[]>(
    `SELECT * FROM integration_sync_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${bounded}`,
    params,
  )
  return rows.map((row) => ({
    id: Number(row.id),
    runId: row.run_id == null ? null : Number(row.run_id),
    eventKey: row.event_key,
    externalId: row.external_id,
    action: row.action,
    detail: json<Record<string, unknown> | null>(row.detail, null),
    createdAt: fromSqlUtc(row.created_at) ?? "",
  }))
}

// ---------------------------------------------------------------------------
// Immutable sync log (append-only, replay-safe)
// ---------------------------------------------------------------------------

/**
 * Append one immutable log event. Returns true when this event was newly
 * recorded, false when it already existed (a replay). The unique (tenant,
 * connection, event_key) guarantees at-most-once semantics; the event_key
 * embeds the external fingerprint so a genuinely changed record is a new event.
 */
async function appendLog(input: {
  tenantId: number
  connectionId: number
  runId: number | null
  eventKey: string
  externalId: string
  action: string
  detail?: Record<string, unknown> | null
}): Promise<boolean> {
  const res = await query<any>(
    `INSERT IGNORE INTO integration_sync_log (tenant_id, connection_id, run_id, event_key, external_id, action, detail)
     VALUES (?,?,?,?,?,?,?)`,
    [
      input.tenantId,
      input.connectionId,
      input.runId,
      input.eventKey.slice(0, 191),
      input.externalId.slice(0, 191),
      input.action,
      input.detail ? JSON.stringify(input.detail) : null,
    ],
  )
  return Number(res.affectedRows) === 1
}

async function logExists(tenantId: number, connectionId: number, eventKey: string): Promise<boolean> {
  const rows = await query<any[]>(
    "SELECT 1 FROM integration_sync_log WHERE tenant_id=? AND connection_id=? AND event_key=? LIMIT 1",
    [tenantId, connectionId, eventKey.slice(0, 191)],
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Mapping baseline helpers
// ---------------------------------------------------------------------------

async function getMapping(
  tenantId: number,
  connectionId: number,
  externalId: string,
): Promise<{ code: string; baseline: SyncBaseline; status: string } | null> {
  const rows = await query<any[]>(
    "SELECT code, external_fingerprint, local_fingerprint, status FROM integration_record_mappings WHERE tenant_id=? AND connection_id=? AND external_id=? LIMIT 1",
    [tenantId, connectionId, externalId],
  )
  if (!rows[0]) return null
  return {
    code: rows[0].code,
    status: rows[0].status,
    baseline: { externalFingerprint: rows[0].external_fingerprint ?? null, localFingerprint: rows[0].local_fingerprint ?? null },
  }
}

async function upsertMapping(input: {
  tenantId: number
  connectionId: number
  externalId: string
  masterKind: string
  code: string
  externalFingerprint: string
  localFingerprint: string
  status: "active" | "conflict"
}): Promise<void> {
  await query(
    `INSERT INTO integration_record_mappings
       (tenant_id, connection_id, external_id, master_kind, code, external_fingerprint, local_fingerprint, status, last_synced_at)
     VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       master_kind=VALUES(master_kind), code=VALUES(code),
       external_fingerprint=VALUES(external_fingerprint), local_fingerprint=VALUES(local_fingerprint),
       status=VALUES(status), last_synced_at=VALUES(last_synced_at)`,
    [
      input.tenantId,
      input.connectionId,
      input.externalId.slice(0, 191),
      input.masterKind,
      input.code,
      input.externalFingerprint,
      input.localFingerprint,
      input.status,
    ],
  )
}

function localToNormalized(row: MasterRow | null): NormalizedRecord | null {
  if (!row) return null
  return { code: row.code, name: row.name, active: row.active, parent: row.parent ?? null, meta: row.meta ?? {} }
}

// ---------------------------------------------------------------------------
// Per-record application (idempotent + replay-safe)
// ---------------------------------------------------------------------------

type RecordOutcome = "applied" | "skipped" | "conflict" | "error"

async function applyRecord(
  conn: SyncConnection,
  masterKind: string,
  runId: number,
  actorId: number | null,
  rec: ProviderRecord,
): Promise<RecordOutcome> {
  const { tenantId, id: connectionId } = conn
  const externalFp = fingerprintNormalized(rec.normalized)
  const eventKey = recordEventKey({ connectionId, externalId: rec.externalId, externalFingerprint: externalFp })

  // Replay guard: if we have already recorded this exact (record, fingerprint)
  // event, applying again would be a duplicate — skip. Master upserts are also
  // idempotent, so even a race here cannot create a duplicate row.
  if (await logExists(tenantId, connectionId, eventKey)) return "skipped"

  const mapping = await getMapping(tenantId, connectionId, rec.externalId)
  const code = mapping?.code ?? rec.normalized.code
  const localRow = await getMaster(masterKind as any, code, { tenantId })
  const localNormalized = localToNormalized(localRow)
  const localFp = localNormalized ? fingerprintNormalized(localNormalized) : null

  const change = classifyChange(mapping?.baseline ?? null, externalFp, localFp)

  if (change === "unchanged") {
    await appendLog({ tenantId, connectionId, runId, eventKey, externalId: rec.externalId, action: "unchanged" })
    return "skipped"
  }

  if (change === "local_only") {
    // ERP moved, provider did not: keep ERP, only refresh the baseline so the
    // local edit is not repeatedly re-detected as a divergence.
    await upsertMapping({
      tenantId, connectionId, externalId: rec.externalId, masterKind, code,
      externalFingerprint: externalFp, localFingerprint: localFp ?? externalFp, status: "active",
    })
    await appendLog({ tenantId, connectionId, runId, eventKey, externalId: rec.externalId, action: "local_kept" })
    return "skipped"
  }

  if (change === "both") {
    // Conflict: do NOT touch master. Record an open conflict for human/strategy
    // resolution and mark the mapping. Baseline is intentionally left as-is.
    await query(
      `INSERT INTO integration_sync_conflicts
         (tenant_id, connection_id, external_id, master_kind, code, status, external_record, local_record, detected_run_id)
       VALUES (?,?,?,?,?, 'open', ?, ?, ?)
       ON DUPLICATE KEY UPDATE external_record=VALUES(external_record), local_record=VALUES(local_record),
         detected_run_id=VALUES(detected_run_id), updated_at=CURRENT_TIMESTAMP`,
      [
        tenantId, connectionId, rec.externalId.slice(0, 191), masterKind, code,
        JSON.stringify(rec.normalized), JSON.stringify(localNormalized), runId,
      ],
    )
    await query(
      "UPDATE integration_record_mappings SET status='conflict' WHERE tenant_id=? AND connection_id=? AND external_id=?",
      [tenantId, connectionId, rec.externalId],
    )
    await appendLog({
      tenantId, connectionId, runId, eventKey, externalId: rec.externalId, action: "conflict_detected",
      detail: { code, masterKind },
    })
    return "conflict"
  }

  // change === "new" || "external_only": apply the external record.
  await upsertMaster(masterKind as any, {
    code, name: rec.normalized.name, active: rec.deleted ? false : rec.normalized.active,
    parent: rec.normalized.parent ?? null, meta: rec.normalized.meta ?? {},
  }, { tenantId, userId: actorId ?? undefined })

  const applied = await getMaster(masterKind as any, code, { tenantId })
  const appliedFp = applied ? fingerprintNormalized(localToNormalized(applied)!) : externalFp
  await upsertMapping({
    tenantId, connectionId, externalId: rec.externalId, masterKind, code,
    externalFingerprint: externalFp, localFingerprint: appliedFp, status: "active",
  })
  await appendLog({
    tenantId, connectionId, runId, eventKey, externalId: rec.externalId,
    action: change === "new" ? "created" : "updated", detail: { code },
  })
  return "applied"
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

async function createOrReuseRun(
  tenantId: number,
  connectionId: number,
  mode: SyncMode,
  maxAttempts: number,
  triggerSource: "manual" | "scheduler",
  actorId: number | null,
  slot: string,
): Promise<{ run: SyncRun; replayed: boolean }> {
  const idempotencyKey = runIdempotencyKey({ tenantId, connectionId, mode, slot }).slice(0, 191)
  const existing = await query<any[]>(
    "SELECT * FROM integration_sync_runs WHERE tenant_id=? AND idempotency_key=? LIMIT 1",
    [tenantId, idempotencyKey],
  )
  if (existing[0]) return { run: mapRun(existing[0]), replayed: true }
  try {
    const res = await query<any>(
      `INSERT INTO integration_sync_runs
         (tenant_id, connection_id, mode, status, idempotency_key, max_attempts, triggered_by, trigger_source)
       VALUES (?,?,?, 'pending', ?,?,?,?)`,
      [tenantId, connectionId, mode, idempotencyKey, maxAttempts, actorId, triggerSource],
    )
    return { run: (await getSyncRun(tenantId, Number(res.insertId)))!, replayed: false }
  } catch (error: any) {
    if (error?.code !== "ER_DUP_ENTRY") throw error
    const rows = await query<any[]>("SELECT * FROM integration_sync_runs WHERE tenant_id=? AND idempotency_key=? LIMIT 1", [tenantId, idempotencyKey])
    return { run: mapRun(rows[0]), replayed: true }
  }
}

export type RunSyncOptions = {
  /** Injected page fetcher (tests / replay). Defaults to the provider registry. */
  fetcher?: PageFetcher
  now?: Date
  pageSize?: number
  triggerSource?: "manual" | "scheduler"
  /** Idempotency slot; identical slot collapses duplicate triggers into one run. */
  slot?: string
  signal?: AbortSignal
}

/**
 * Execute (or resume) one sync for a connection. Safe to call repeatedly: the
 * run is keyed by an idempotency slot, pages are checkpointed, and per-record
 * application is replay-safe. On provider outage the run is left retryable with
 * a backoff deadline instead of throwing.
 */
export async function runConnectionSync(
  tenantId: number,
  actorId: number | null,
  connectionId: number,
  mode: SyncMode,
  options: RunSyncOptions = {},
): Promise<SyncRun> {
  await ensureIntegrationSyncSchema()
  const now = options.now ?? new Date()
  const conn = await getSyncConnection(tenantId, connectionId)
  if (!conn) throw new SyncConnectionNotFound("Sync connection not found")
  if (!isKnownSource(conn.providerKey, conn.entityKind)) {
    throw new SyncError(`No sync source registered for ${conn.providerKey}/${conn.entityKind}`, "config")
  }
  const source = getSyncSource(conn.providerKey, conn.entityKind)!
  const fetcher = options.fetcher ?? resolveFetcher(conn.providerKey)
  const pageSize = clampPageSize(options.pageSize ?? SYNC_LIMITS.defaultPageSize)
  const slot = options.slot ?? now.toISOString()

  const { run, replayed } = await createOrReuseRun(
    tenantId, connectionId, mode, SYNC_LIMITS.maxAttempts,
    options.triggerSource ?? "manual", actorId, slot,
  )
  if (replayed && (run.status === "succeeded" || run.status === "running")) return run

  // Determine the starting cursor. Initial mode always starts clean; incremental
  // resumes from the run checkpoint (crash recovery) or the connection position.
  // A stale checkpoint (older generation) is discarded and we restart clean.
  let cursor: Cursor
  if (mode === "initial") {
    cursor = emptyCursor(conn.generation)
  } else {
    const checkpoint = run.checkpointCursor
    if (checkpoint && !isStaleCursor(checkpoint, conn.generation)) {
      cursor = decodeCursor(checkpoint) ?? emptyCursor(conn.generation)
    } else if (checkpoint) {
      // Stale checkpoint → restart from the connection baseline.
      cursor = { position: conn.cursorPosition, page: 0, generation: conn.generation }
      await appendLog({
        tenantId, connectionId, runId: run.id, eventKey: `cursor_reset:${run.id}`,
        externalId: "-", action: "cursor_reset", detail: { reason: "stale_checkpoint" },
      })
    } else {
      cursor = { position: conn.cursorPosition, page: 0, generation: conn.generation }
    }
  }

  await query(
    "UPDATE integration_sync_runs SET status='running', attempts=attempts+1, started_at=COALESCE(started_at, ?), next_retry_at=NULL WHERE tenant_id=? AND id=?",
    [toSqlUtc(now), tenantId, run.id],
  )
  await query("UPDATE integration_sync_connections SET status='syncing' WHERE tenant_id=? AND id=?", [tenantId, connectionId])

  const counts = { pages: run.pages, fetched: run.fetched, applied: run.applied, skipped: run.skipped, conflicts: run.conflicts, errors: run.errors }
  let processed = 0

  try {
    let pagesThisRun = 0
    for (;;) {
      if (pagesThisRun >= SYNC_LIMITS.maxPagesPerRun) break
      const page = await fetcher({ tenantId, cursor: cursor.position, limit: pageSize, config: conn.config, signal: options.signal })
      pagesThisRun++
      counts.pages++
      counts.fetched += page.records.length

      for (const rec of page.records) {
        if (!rec || !rec.externalId) {
          counts.errors++
          continue
        }
        try {
          const outcome = await applyRecord(conn, conn.masterKind, run.id, actorId, rec)
          if (outcome === "applied") counts.applied++
          else if (outcome === "skipped") counts.skipped++
          else if (outcome === "conflict") counts.conflicts++
          processed++
        } catch (error) {
          counts.errors++
          if (error instanceof SyncError && error.kind === "outage") throw error // provider outage aborts the page loop
          console.error("[integration-sync] record failed", {
            connectionId, externalId: rec.externalId, error: error instanceof Error ? error.message : error,
          })
        }
      }

      cursor = advanceCursor(cursor, page)
      // CHECKPOINT after every page so a crash/timeout resumes here.
      await query(
        `UPDATE integration_sync_runs SET pages=?, fetched=?, applied=?, skipped=?, conflicts=?, errors=?, checkpoint_cursor=? WHERE tenant_id=? AND id=?`,
        [counts.pages, counts.fetched, counts.applied, counts.skipped, counts.conflicts, counts.errors, encodeCursor(cursor), tenantId, run.id],
      )
      if (!page.hasMore || page.nextCursor == null) break
    }

    const status = summarizeRunStatus({ errors: counts.errors, conflicts: counts.conflicts, processed })
    await finishRun(tenantId, run.id, status, counts, null, cursor)
    await query(
      `UPDATE integration_sync_connections
         SET status=?, cursor_position=?, last_run_id=?, last_synced_at=?, last_error=NULL, version=version+1
       WHERE tenant_id=? AND id=?`,
      [status === "failed" ? "error" : "idle", cursor.position, run.id, toSqlUtc(now), tenantId, connectionId],
    )
    await recordAuditLog({
      action: "integration_sync.run.finished",
      result: status === "failed" ? "failure" : "success",
      entityType: "integration_sync_run",
      entityId: run.id,
      metadata: { mode, status, ...counts },
    })
    return (await getSyncRun(tenantId, run.id))!
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const attempts = run.attempts + 1
    const retryable = shouldRetry(attempts) && !(error instanceof SyncError && (error.kind === "config" || error.kind === "validation"))
    const nextRetryAt = retryable ? new Date(now.getTime() + backoffSeconds(attempts) * 1000) : null
    await finishRun(tenantId, run.id, retryable ? "pending" : "failed", counts, message, cursor, nextRetryAt)
    await query(
      "UPDATE integration_sync_connections SET status='error', last_error=?, last_run_id=?, version=version+1 WHERE tenant_id=? AND id=?",
      [message.slice(0, 500), run.id, tenantId, connectionId],
    )
    await recordAuditLog({
      action: "integration_sync.run.error",
      result: "failure",
      entityType: "integration_sync_run",
      entityId: run.id,
      metadata: { mode, retryable, attempts, error: message.slice(0, 200) },
    })
    return (await getSyncRun(tenantId, run.id))!
  }
}

async function finishRun(
  tenantId: number,
  runId: number,
  status: RunStatus | "pending",
  counts: { pages: number; fetched: number; applied: number; skipped: number; conflicts: number; errors: number },
  errorMessage: string | null,
  cursor: Cursor,
  nextRetryAt: Date | null = null,
): Promise<void> {
  const terminal = status !== "pending"
  await query(
    `UPDATE integration_sync_runs
       SET status=?, pages=?, fetched=?, applied=?, skipped=?, conflicts=?, errors=?, checkpoint_cursor=?,
           error_message=?, next_retry_at=?, finished_at=? 
     WHERE tenant_id=? AND id=?`,
    [
      status, counts.pages, counts.fetched, counts.applied, counts.skipped, counts.conflicts, counts.errors,
      encodeCursor(cursor), errorMessage ? errorMessage.slice(0, 2000) : null,
      nextRetryAt ? toSqlUtc(nextRetryAt) : null, terminal ? toSqlUtc(new Date()) : null,
      tenantId, runId,
    ],
  )
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an open conflict with one of the three strategies and apply the
 * outcome to master data. Idempotent: a second resolve of the same (now closed)
 * conflict is rejected rather than double-applied.
 */
export async function resolveSyncConflict(
  tenantId: number,
  actorId: number,
  conflictId: number,
  resolution: ConflictResolution,
  mergePatch?: Partial<NormalizedRecord> | null,
): Promise<SyncConflict> {
  await ensureIntegrationSyncSchema()
  if (!isValidResolution(resolution)) throw new SyncError("Invalid resolution strategy", "validation")
  const conflict = await getSyncConflict(tenantId, conflictId)
  if (!conflict) throw new SyncConflictNotFound("Conflict not found")
  if (conflict.status === "resolved") throw new SyncConflictAlreadyResolved("Conflict already resolved")
  if (!conflict.externalRecord) throw new SyncError("Conflict is missing its external snapshot", "validation")

  // Atomically claim the conflict so concurrent resolves cannot both apply.
  const claim = await query<any>(
    "UPDATE integration_sync_conflicts SET status='resolved', resolution=?, resolved_by=?, resolved_at=UTC_TIMESTAMP() WHERE tenant_id=? AND id=? AND status='open'",
    [resolution, actorId, tenantId, conflictId],
  )
  if (Number(claim.affectedRows) !== 1) throw new SyncConflictAlreadyResolved("Conflict already resolved")

  const outcome = resolveConflict(resolution, conflict.externalRecord, conflict.localRecord, mergePatch)

  if (outcome.writeMaster && outcome.record) {
    await upsertMaster(conflict.masterKind as any, {
      code: outcome.record.code, name: outcome.record.name, active: outcome.record.active,
      parent: outcome.record.parent ?? null, meta: outcome.record.meta ?? {},
    }, { tenantId, userId: actorId })
  }

  await upsertMapping({
    tenantId, connectionId: conflict.connectionId, externalId: conflict.externalId,
    masterKind: conflict.masterKind, code: outcome.record?.code ?? conflict.code,
    externalFingerprint: outcome.externalFingerprint, localFingerprint: outcome.localFingerprint, status: "active",
  })

  await appendLog({
    tenantId, connectionId: conflict.connectionId, runId: null,
    eventKey: `conflict_resolved:${conflictId}:${resolution}`,
    externalId: conflict.externalId, action: "conflict_resolved", detail: { resolution, code: conflict.code },
  })
  await recordAuditLog({
    action: "integration_sync.conflict.resolve",
    entityType: "integration_sync_conflict",
    entityId: conflictId,
    after: { resolution, writeMaster: outcome.writeMaster },
  })
  return (await getSyncConflict(tenantId, conflictId))!
}

// ---------------------------------------------------------------------------
// Scheduler dispatch (cron)
// ---------------------------------------------------------------------------

export type DispatchSummary = { considered: number; started: number; retried: number; errors: number }

/**
 * One scheduler tick. Picks up (a) connections whose next_run_at is due for an
 * incremental sync and (b) retryable runs whose backoff has elapsed, and drives
 * each. Runs inline (bounded by pages/attempts). Safe under overlapping ticks:
 * a run is keyed by its idempotency slot and a run already 'running' is skipped.
 */
export async function dispatchDueSyncs(now = new Date(), limit = 100): Promise<DispatchSummary> {
  await ensureIntegrationSyncSchema()
  const summary: DispatchSummary = { considered: 0, started: 0, retried: 0, errors: 0 }

  // (a) Retryable runs first — resume before starting new work.
  const retryRuns = await query<any[]>(
    `SELECT * FROM integration_sync_runs WHERE status='pending' AND next_retry_at IS NOT NULL AND next_retry_at<=? ORDER BY next_retry_at ASC LIMIT ?`,
    [toSqlUtc(now), limit],
  )
  for (const row of retryRuns) {
    summary.considered++
    const run = mapRun(row)
    if (run.attempts >= run.maxAttempts) {
      await query("UPDATE integration_sync_runs SET status='failed', next_retry_at=NULL, finished_at=? WHERE tenant_id=? AND id=?", [toSqlUtc(now), run.tenantId, run.id])
      continue
    }
    try {
      // Reuse the same idempotency slot so this resumes the SAME run row.
      const idem = row.idempotency_key as string
      const slot = idem.split(":").slice(4).join(":")
      await runConnectionSync(run.tenantId, row.triggered_by ? Number(row.triggered_by) : null, run.connectionId, run.mode, {
        now, triggerSource: "scheduler", slot,
      })
      summary.retried++
    } catch (error) {
      summary.errors++
      console.error("[integration-sync] retry dispatch failed", { runId: run.id, error: error instanceof Error ? error.message : error })
    }
  }

  // (b) Due connections for scheduled incremental sync.
  const due = await query<any[]>(
    `SELECT * FROM integration_sync_connections WHERE enabled=1 AND status<>'syncing' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at ASC LIMIT ?`,
    [toSqlUtc(now), limit],
  )
  for (const row of due) {
    summary.considered++
    const conn = mapConnection(row)
    try {
      const mode: SyncMode = conn.cursorPosition ? "incremental" : "initial"
      await runConnectionSync(conn.tenantId, null, conn.id, mode, {
        now, triggerSource: "scheduler", slot: `sched:${toSqlUtc(now)}`,
      })
      summary.started++
    } catch (error) {
      summary.errors++
      console.error("[integration-sync] scheduled dispatch failed", { connectionId: conn.id, error: error instanceof Error ? error.message : error })
    }
  }

  return summary
}
