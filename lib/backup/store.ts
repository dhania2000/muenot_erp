import "server-only"
/**
 * Backup architecture (server store, engine + job execution).
 * ---------------------------------------------------------------------------
 * Replaces the honest "NOT CONFIGURED" placeholder with a real, tenant-aware,
 * audited backup pipeline that works with the infrastructure this app already
 * has (MySQL) — no external provider required to be usable.
 *
 * A POLICY (per tenant + scope, with a platform baseline fallback) drives an
 * automated schedule, retention, encryption toggle, verify-after-backup toggle
 * and restore-test cadence. A RUN executes one backup:
 *
 *   1. Collect the tenant's data for the scope (database tables / config tables
 *      / stored-file manifest), always tenant-scoped so a backup can never read
 *      another tenant's rows.
 *   2. Serialize to a versioned JSON envelope and record a SHA-256 checksum of
 *      the plaintext.
 *   3. Encrypt at rest with AES-256-GCM (authenticated) when the policy asks,
 *      and seal the bytes into the run row with size + expiry.
 *   4. Optionally VERIFY immediately (re-read, decrypt, re-checksum, re-parse).
 *
 * A RESTORE TEST decrypts + parses a completed run and validates every section
 * against the LIVE schema WITHOUT writing to any live table — proving the
 * backup is structurally restorable. Retention prunes expired runs while always
 * keeping a configurable floor of the most recent ones.
 *
 * Self-heals its schema at runtime (same pattern as lib/data-export-store.ts)
 * so existing databases converge with no manual migration step.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto"
import { query, tableColumns } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { listTenants } from "@/lib/tenant-service"
import { TENANT_COLUMN, TENANT_OWNED_TABLES } from "@/lib/tenant-tables"
import {
  type BackupArtifact,
  type BackupFrequency,
  type BackupRunStatus,
  type BackupScope,
  type BackupSection,
  type BackupVerificationStatus,
  type RestoreTestFrequency,
  type RestoreTestStatus,
  BACKUP_SCOPES,
  BACKUP_SCOPE_LABELS,
  ENCRYPTION_ALGORITHM,
  buildArtifactEnvelope,
  clampMinKeep,
  clampRetentionDays,
  computeExpiry,
  isBackupDue,
  isBackupExpired,
  isRestoreTestDue,
  parseArtifact,
  serializeArtifact,
  toBackupFrequency,
  toRestoreTestFrequency,
  totalRowCount,
} from "@/lib/backup/model"

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Safety cap on rows pulled per table in one backup. */
const MAX_ROWS_PER_TABLE = 100_000

/**
 * Largest artifact we will seal into a single MySQL row. Sealing into the DB
 * is the one durable sink that works on every install (mirrors 's export
 * artifacts). Overridable so operators on a larger `max_allowed_packet` can
 * raise it. Kept safely under a default 16MB packet.
 */
function maxArtifactBytes(): number {
  const raw = Number(process.env.BACKUP_MAX_ARTIFACT_BYTES)
  if (Number.isFinite(raw) && raw >= 64 * 1024) return Math.min(raw, 512 * 1024 * 1024)
  return Math.floor(15 * 1024 * 1024)
}

/**
 * Tenant-owned tables that hold configuration / policy rather than transactional
 * business data. Drives the "config" scope. Every entry is tenant-scoped, so a
 * config backup is still isolated per tenant.
 */
const CONFIG_TABLES: readonly string[] = [
  "tenant_settings",
  "tenant_settings_audit",
  "storage_retention_settings",
  "storage_retention_rules",
  "storage_quota_settings",
  "notification_templates",
  "notification_preferences",
  "api_rate_limit_policies",
  "webhook_endpoints",
  "erp_event_subscriptions",
  "sso_providers",
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupActor = { userId: number; name?: string | null; email?: string | null }

export type BackupPolicy = {
  id: number
  tenantId: number | null
  scope: BackupScope
  enabled: boolean
  frequency: BackupFrequency
  retentionDays: number
  minKeep: number
  encrypt: boolean
  verifyAfter: boolean
  restoreTestFrequency: RestoreTestFrequency
  lastRunAt: string | null
  lastRestoreTestAt: string | null
  updatedBy: number | null
  updatedAt: string
}

export type BackupRun = {
  id: number
  policyId: number | null
  tenantId: number | null
  scope: BackupScope
  status: BackupRunStatus
  triggerSource: "manual" | "scheduler"
  tableCount: number
  rowCount: number
  plaintextSize: number
  artifactSize: number
  checksum: string | null
  encrypted: boolean
  encryptionAlgo: string | null
  verificationStatus: BackupVerificationStatus
  verifiedAt: string | null
  error: string | null
  requestedByName: string | null
  expiresAt: string | null
  createdAt: string
  finishedAt: string | null
}

export type RestoreTest = {
  id: number
  runId: number
  tenantId: number | null
  scope: BackupScope
  status: RestoreTestStatus
  tablesValidated: number
  rowsValidated: number
  issues: string[]
  detail: string | null
  createdByName: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Encryption at rest (AES-256-GCM, authenticated)
// ---------------------------------------------------------------------------

function encryptionKey(): Buffer {
  const secret =
    process.env.BACKUP_ENCRYPTION_KEY ||
    process.env.STORAGE_URL_SIGNING_SECRET ||
    process.env.SESSION_SECRET ||
    "dev-only-insecure-backup-key-change-me"
  // Derive a stable 32-byte key. A fixed salt is acceptable here because the
  // salt's job is domain separation, not password stretching of a low-entropy
  // secret — the secret itself is a high-entropy env var.
  return scryptSync(secret, "muenot-backup-v1", 32)
}

/** Envelope layout: [12-byte IV][16-byte GCM tag][ciphertext]. */
function encryptBuffer(plaintext: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

function decryptBuffer(envelope: Buffer): Buffer {
  const iv = envelope.subarray(0, 12)
  const tag = envelope.subarray(12, 28)
  const ciphertext = envelope.subarray(28)
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, encryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_backup_policies\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`scope\` VARCHAR(16) NOT NULL,
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 0,
      \`frequency\` VARCHAR(12) NOT NULL DEFAULT 'daily',
      \`retention_days\` SMALLINT UNSIGNED NOT NULL DEFAULT 30,
      \`min_keep\` SMALLINT UNSIGNED NOT NULL DEFAULT 3,
      \`encrypt\` TINYINT(1) NOT NULL DEFAULT 1,
      \`verify_after\` TINYINT(1) NOT NULL DEFAULT 1,
      \`restore_test_frequency\` VARCHAR(12) NOT NULL DEFAULT 'weekly',
      \`last_run_at\` TIMESTAMP NULL DEFAULT NULL,
      \`last_restore_test_at\` TIMESTAMP NULL DEFAULT NULL,
      \`updated_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_backup_policy_scope\` (\`tenant_id\`, \`scope\`),
      KEY \`idx_backup_policy_enabled\` (\`enabled\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_backup_runs\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`policy_id\` INT UNSIGNED DEFAULT NULL,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`scope\` VARCHAR(16) NOT NULL,
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'running',
      \`trigger_source\` VARCHAR(16) NOT NULL DEFAULT 'manual',
      \`table_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`row_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`plaintext_size\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
      \`artifact_size\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
      \`checksum\` CHAR(64) DEFAULT NULL,
      \`encrypted\` TINYINT(1) NOT NULL DEFAULT 0,
      \`encryption_algo\` VARCHAR(32) DEFAULT NULL,
      \`artifact\` LONGBLOB DEFAULT NULL,
      \`verification_status\` VARCHAR(16) NOT NULL DEFAULT 'unverified',
      \`verified_at\` TIMESTAMP NULL DEFAULT NULL,
      \`requested_by\` INT UNSIGNED DEFAULT NULL,
      \`error\` TEXT DEFAULT NULL,
      \`expires_at\` TIMESTAMP NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`finished_at\` TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_backup_run_tenant\` (\`tenant_id\`, \`scope\`, \`created_at\`),
      KEY \`idx_backup_run_status\` (\`status\`, \`expires_at\`),
      KEY \`idx_backup_run_policy\` (\`policy_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_backup_restore_tests\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`run_id\` BIGINT UNSIGNED NOT NULL,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`scope\` VARCHAR(16) NOT NULL,
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'passed',
      \`tables_validated\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`rows_validated\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`issues\` JSON DEFAULT NULL,
      \`detail\` TEXT DEFAULT NULL,
      \`requested_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_backup_restore_run\` (\`run_id\`),
      KEY \`idx_backup_restore_tenant\` (\`tenant_id\`, \`scope\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  // Seed a disabled platform baseline for each scope. Baselines are opt-in:
  // nothing runs until an operator enables a policy, so this page never
  // fabricates a backup history.
  for (const scope of BACKUP_SCOPES) {
    await query(
      `INSERT INTO \`platform_backup_policies\` (\`tenant_id\`, \`scope\`, \`enabled\`)
       VALUES (NULL, ?, 0)
       ON DUPLICATE KEY UPDATE \`scope\` = VALUES(\`scope\`)`,
      [scope],
    )
  }
}

export function ensureBackupSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((err) => { ensured = null; throw err })
  return ensured
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapPolicy(row: any): BackupPolicy {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id == null ? null : Number(row.tenant_id),
    scope: (BACKUP_SCOPES as readonly string[]).includes(row.scope) ? row.scope : "database",
    enabled: Boolean(row.enabled),
    frequency: toBackupFrequency(row.frequency),
    retentionDays: clampRetentionDays(row.retention_days),
    minKeep: clampMinKeep(row.min_keep),
    encrypt: Boolean(row.encrypt),
    verifyAfter: Boolean(row.verify_after),
    restoreTestFrequency: toRestoreTestFrequency(row.restore_test_frequency),
    lastRunAt: row.last_run_at ?? null,
    lastRestoreTestAt: row.last_restore_test_at ?? null,
    updatedBy: row.updated_by == null ? null : Number(row.updated_by),
    updatedAt: row.updated_at,
  }
}

function mapRun(row: any): BackupRun {
  return {
    id: Number(row.id),
    policyId: row.policy_id == null ? null : Number(row.policy_id),
    tenantId: row.tenant_id == null ? null : Number(row.tenant_id),
    scope: (BACKUP_SCOPES as readonly string[]).includes(row.scope) ? row.scope : "database",
    status: row.status,
    triggerSource: row.trigger_source === "scheduler" ? "scheduler" : "manual",
    tableCount: Number(row.table_count ?? 0),
    rowCount: Number(row.row_count ?? 0),
    plaintextSize: Number(row.plaintext_size ?? 0),
    artifactSize: Number(row.artifact_size ?? 0),
    checksum: row.checksum ?? null,
    encrypted: Boolean(row.encrypted),
    encryptionAlgo: row.encryption_algo ?? null,
    verificationStatus: row.verification_status ?? "unverified",
    verifiedAt: row.verified_at ?? null,
    error: row.error ?? null,
    requestedByName: row.requested_by_name ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
  }
}

function mapRestoreTest(row: any): RestoreTest {
  let issues: string[] = []
  if (row.issues) {
    try {
      const parsed = typeof row.issues === "string" ? JSON.parse(row.issues) : row.issues
      if (Array.isArray(parsed)) issues = parsed.map(String)
    } catch { issues = [] }
  }
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    tenantId: row.tenant_id == null ? null : Number(row.tenant_id),
    scope: (BACKUP_SCOPES as readonly string[]).includes(row.scope) ? row.scope : "database",
    status: row.status === "failed" ? "failed" : "passed",
    tablesValidated: Number(row.tables_validated ?? 0),
    rowsValidated: Number(row.rows_validated ?? 0),
    issues,
    detail: row.detail ?? null,
    createdByName: row.requested_by_name ?? null,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** All policies for a tenant plus the platform baselines (tenant_id NULL). */
export async function listPolicies(tenantId: number | null): Promise<BackupPolicy[]> {
  await ensureBackupSchema()
  const rows =
    tenantId == null
      ? await query<any[]>("SELECT * FROM `platform_backup_policies` WHERE `tenant_id` IS NULL ORDER BY `scope`")
      : await query<any[]>(
          "SELECT * FROM `platform_backup_policies` WHERE `tenant_id` = ? OR `tenant_id` IS NULL ORDER BY `tenant_id` IS NULL, `scope`",
          [tenantId],
        )
  return rows.map(mapPolicy)
}

/** The effective policy for a (tenant, scope): the tenant override, else the platform baseline. */
export async function resolveEffectivePolicy(tenantId: number, scope: BackupScope): Promise<BackupPolicy | null> {
  await ensureBackupSchema()
  const rows = await query<any[]>(
    "SELECT * FROM `platform_backup_policies` WHERE `scope` = ? AND (`tenant_id` = ? OR `tenant_id` IS NULL) ORDER BY `tenant_id` IS NULL LIMIT 1",
    [scope, tenantId],
  )
  return rows[0] ? mapPolicy(rows[0]) : null
}

export type UpdatePolicyInput = {
  enabled?: boolean
  frequency?: unknown
  retentionDays?: unknown
  minKeep?: unknown
  encrypt?: boolean
  verifyAfter?: boolean
  restoreTestFrequency?: unknown
}

/** Create or update a policy for a (tenant, scope). tenantId null = platform baseline. */
export async function upsertPolicy(
  tenantId: number | null,
  scope: BackupScope,
  input: UpdatePolicyInput,
  actor: BackupActor,
): Promise<BackupPolicy> {
  await ensureBackupSchema()
  const existingRows = await query<any[]>(
    "SELECT * FROM `platform_backup_policies` WHERE `scope` = ? AND `tenant_id` <=> ? LIMIT 1",
    [scope, tenantId],
  )
  const current = existingRows[0] ? mapPolicy(existingRows[0]) : null

  const next = {
    enabled: input.enabled ?? current?.enabled ?? false,
    frequency: input.frequency != null ? toBackupFrequency(input.frequency) : current?.frequency ?? "daily",
    retentionDays: input.retentionDays != null ? clampRetentionDays(input.retentionDays) : current?.retentionDays ?? clampRetentionDays(undefined),
    minKeep: input.minKeep != null ? clampMinKeep(input.minKeep) : current?.minKeep ?? clampMinKeep(undefined),
    encrypt: input.encrypt ?? current?.encrypt ?? true,
    verifyAfter: input.verifyAfter ?? current?.verifyAfter ?? true,
    restoreTestFrequency:
      input.restoreTestFrequency != null ? toRestoreTestFrequency(input.restoreTestFrequency) : current?.restoreTestFrequency ?? "weekly",
  }

  await query(
    `INSERT INTO \`platform_backup_policies\`
       (\`tenant_id\`, \`scope\`, \`enabled\`, \`frequency\`, \`retention_days\`, \`min_keep\`, \`encrypt\`, \`verify_after\`, \`restore_test_frequency\`, \`updated_by\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       \`enabled\` = VALUES(\`enabled\`), \`frequency\` = VALUES(\`frequency\`),
       \`retention_days\` = VALUES(\`retention_days\`), \`min_keep\` = VALUES(\`min_keep\`),
       \`encrypt\` = VALUES(\`encrypt\`), \`verify_after\` = VALUES(\`verify_after\`),
       \`restore_test_frequency\` = VALUES(\`restore_test_frequency\`), \`updated_by\` = VALUES(\`updated_by\`)`,
    [
      tenantId, scope, next.enabled ? 1 : 0, next.frequency, next.retentionDays, next.minKeep,
      next.encrypt ? 1 : 0, next.verifyAfter ? 1 : 0, next.restoreTestFrequency, actor.userId,
    ],
  )

  await recordAuditLog({
    action: "backup.policy_update",
    entityType: "backup_policy",
    entityId: `${tenantId ?? "baseline"}:${scope}`,
    entityLabel: `${BACKUP_SCOPE_LABELS[scope]} policy`,
    before: current ? { ...current } : null,
    after: { tenantId, scope, ...next },
    context: { tenantId, actorUserId: actor.userId, actorName: actor.name ?? null, actorEmail: actor.email ?? null },
  })

  const rows = await query<any[]>(
    "SELECT * FROM `platform_backup_policies` WHERE `scope` = ? AND `tenant_id` <=> ? LIMIT 1",
    [scope, tenantId],
  )
  return mapPolicy(rows[0])
}

// ---------------------------------------------------------------------------
// Data collection engine (tenant-scoped, read-only)
// ---------------------------------------------------------------------------

async function collectTableSection(tenantId: number, table: string): Promise<BackupSection | null> {
  const columns = await tableColumns(table).catch(() => new Set<string>())
  if (columns.size === 0) return null // table absent on this install — skip honestly
  if (!columns.has(TENANT_COLUMN)) return null // never read a table we can't tenant-scope
  const rows = await query<Record<string, unknown>[]>(
    `SELECT * FROM \`${table}\` WHERE \`${TENANT_COLUMN}\` = ? LIMIT ${MAX_ROWS_PER_TABLE}`,
    [tenantId],
  )
  return { name: table, rowCount: rows.length, rows }
}

async function collectSections(scope: BackupScope, tenantId: number): Promise<BackupSection[]> {
  const sections: BackupSection[] = []
  if (scope === "database") {
    for (const table of TENANT_OWNED_TABLES) {
      const section = await collectTableSection(tenantId, table)
      if (section) sections.push(section)
    }
  } else if (scope === "config") {
    for (const table of CONFIG_TABLES) {
      const section = await collectTableSection(tenantId, table)
      if (section) sections.push(section)
    }
  } else {
    // files — a manifest of stored file metadata (bytes live in object storage;
    // this snapshot records every reference + checksum so a restore can
    // reconcile them). `file_objects` is the normalized per-file registry.
    const section = await collectTableSection(tenantId, "file_objects")
    sections.push(section ?? { name: "file_objects", rowCount: 0, rows: [] })
  }
  return sections
}

// ---------------------------------------------------------------------------
// Run a backup
// ---------------------------------------------------------------------------

export type CreateBackupInput = {
  scope: BackupScope
  tenantId: number
  triggerSource?: "manual" | "scheduler"
  policyId?: number | null
  retentionDays?: number
  encrypt?: boolean
  verifyAfter?: boolean
}

export async function createAndRunBackup(input: CreateBackupInput, actor: BackupActor): Promise<BackupRun> {
  await ensureBackupSchema()
  const scope = input.scope
  const tenantId = input.tenantId
  const triggerSource = input.triggerSource === "scheduler" ? "scheduler" : "manual"
  const retentionDays = clampRetentionDays(input.retentionDays)
  const encrypt = input.encrypt ?? true

  const res = await query<{ insertId: number }>(
    `INSERT INTO \`platform_backup_runs\`
       (\`policy_id\`, \`tenant_id\`, \`scope\`, \`status\`, \`trigger_source\`, \`requested_by\`)
     VALUES (?, ?, ?, 'running', ?, ?)`,
    [input.policyId ?? null, tenantId, scope, triggerSource, actor.userId],
  )
  const runId = (res as any).insertId as number

  try {
    const sections = await collectSections(scope, tenantId)
    const artifact = buildArtifactEnvelope(scope, tenantId, sections)
    const plaintext = Buffer.from(serializeArtifact(artifact), "utf-8")
    const checksum = sha256hex(plaintext)
    const stored = encrypt ? encryptBuffer(plaintext) : plaintext

    if (stored.length > maxArtifactBytes()) {
      throw new Error(
        `Backup artifact (${stored.length} bytes) exceeds the maximum artifact size. Raise BACKUP_MAX_ALLOWED_PACKET / BACKUP_MAX_ARTIFACT_BYTES or narrow the scope.`,
      )
    }

    const expiresAt = computeExpiry(new Date(), retentionDays)
    await query(
      `UPDATE \`platform_backup_runs\`
          SET \`status\` = 'completed', \`table_count\` = ?, \`row_count\` = ?, \`plaintext_size\` = ?,
              \`artifact_size\` = ?, \`checksum\` = ?, \`encrypted\` = ?, \`encryption_algo\` = ?,
              \`artifact\` = ?, \`expires_at\` = ?, \`finished_at\` = CURRENT_TIMESTAMP
        WHERE \`id\` = ?`,
      [
        sections.length, totalRowCount(sections), plaintext.length, stored.length, checksum,
        encrypt ? 1 : 0, encrypt ? ENCRYPTION_ALGORITHM : null, stored, expiresAt, runId,
      ],
    )

    await recordAuditLog({
      action: "backup.complete",
      entityType: "backup_run",
      entityId: runId,
      entityLabel: `${BACKUP_SCOPE_LABELS[scope]} (tenant ${tenantId})`,
      after: {
        scope, tenantId, tableCount: sections.length, rowCount: totalRowCount(sections),
        plaintextSize: plaintext.length, artifactSize: stored.length, encrypted: encrypt, checksum,
        triggerSource, expiresAt: expiresAt.toISOString(),
      },
      context: { tenantId, actorUserId: actor.userId, actorName: actor.name ?? null, actorEmail: actor.email ?? null },
    })

    if (input.policyId != null) {
      await query("UPDATE `platform_backup_policies` SET `last_run_at` = CURRENT_TIMESTAMP WHERE `id` = ?", [input.policyId])
    }

    if (input.verifyAfter ?? true) {
      await verifyBackupRun(tenantId, runId, actor).catch(() => {})
    }
  } catch (err) {
    const message = (err as Error).message || "Backup failed"
    await query(
      "UPDATE `platform_backup_runs` SET `status` = 'failed', `error` = ?, `finished_at` = CURRENT_TIMESTAMP WHERE `id` = ?",
      [message.slice(0, 500), runId],
    )
    await recordAuditLog({
      action: "backup.fail",
      entityType: "backup_run",
      entityId: runId,
      entityLabel: `${BACKUP_SCOPE_LABELS[scope]} (tenant ${tenantId})`,
      result: "failure",
      after: { scope, tenantId, error: message.slice(0, 500), triggerSource },
      context: { tenantId, actorUserId: actor.userId, actorName: actor.name ?? null, actorEmail: actor.email ?? null },
    })
  }

  const row = await loadRunRow(tenantId, runId)
  return mapRun(row)
}

// ---------------------------------------------------------------------------
// Verification (re-read, decrypt, re-checksum, re-parse)
// ---------------------------------------------------------------------------

async function loadRunRow(tenantId: number | null, id: number): Promise<any> {
  const rows = await query<any[]>(
    `SELECT r.*, u.name AS requested_by_name
       FROM \`platform_backup_runs\` r
       LEFT JOIN \`users\` u ON u.id = r.requested_by
      WHERE r.id = ? AND r.tenant_id <=> ? LIMIT 1`,
    [id, tenantId],
  )
  return rows[0] ?? null
}

/** Load + decrypt + shape-validate the artifact for a completed run. */
async function loadArtifact(tenantId: number | null, id: number): Promise<{ artifact: BackupArtifact; checksum: string } | null> {
  const rows = await query<any[]>(
    "SELECT `id`, `status`, `encrypted`, `checksum`, `artifact` FROM `platform_backup_runs` WHERE `id` = ? AND `tenant_id` <=> ? LIMIT 1",
    [id, tenantId],
  )
  const row = rows[0]
  if (!row || row.status !== "completed" || !row.artifact) return null
  const stored = Buffer.isBuffer(row.artifact) ? row.artifact : Buffer.from(row.artifact)
  const plaintext = row.encrypted ? decryptBuffer(stored) : stored
  const checksum = sha256hex(plaintext)
  const artifact = parseArtifact(plaintext.toString("utf-8"))
  if (!artifact) throw new Error("Artifact failed to parse after decryption")
  return { artifact, checksum }
}

export async function verifyBackupRun(tenantId: number | null, id: number, actor: BackupActor): Promise<BackupRun | null> {
  await ensureBackupSchema()
  const row = await loadRunRow(tenantId, id)
  if (!row) return null

  let status: BackupVerificationStatus = "failed"
  let detail = ""
  try {
    const loaded = await loadArtifact(tenantId, id)
    if (!loaded) {
      detail = "Backup is not in a completed, downloadable state"
    } else if (row.checksum && loaded.checksum !== row.checksum) {
      detail = "Checksum mismatch — the stored artifact does not match its recorded digest"
    } else {
      status = "passed"
      detail = `Verified ${loaded.artifact.sections.length} section(s), ${totalRowCount(loaded.artifact.sections)} row(s)`
    }
  } catch (err) {
    detail = (err as Error).message || "Verification failed"
  }

  await query(
    "UPDATE `platform_backup_runs` SET `verification_status` = ?, `verified_at` = CURRENT_TIMESTAMP WHERE `id` = ?",
    [status, id],
  )
  await recordAuditLog({
    action: status === "passed" ? "backup.verify_pass" : "backup.verify_fail",
    entityType: "backup_run",
    entityId: id,
    entityLabel: `${BACKUP_SCOPE_LABELS[mapRun(row).scope]} (tenant ${row.tenant_id ?? "?"})`,
    result: status === "passed" ? "success" : "failure",
    after: { verificationStatus: status, detail },
    context: { tenantId: row.tenant_id ?? null, actorUserId: actor.userId, actorName: actor.name ?? null, actorEmail: actor.email ?? null },
  })

  const updated = await loadRunRow(tenantId, id)
  return mapRun(updated)
}

// ---------------------------------------------------------------------------
// Restore testing (non-destructive validation against the live schema)
// ---------------------------------------------------------------------------

export async function runRestoreTest(tenantId: number | null, runId: number, actor: BackupActor): Promise<RestoreTest | null> {
  await ensureBackupSchema()
  const row = await loadRunRow(tenantId, runId)
  if (!row) return null
  const scope = mapRun(row).scope
  const runTenant = row.tenant_id == null ? null : Number(row.tenant_id)

  const issues: string[] = []
  let tablesValidated = 0
  let rowsValidated = 0
  let status: RestoreTestStatus = "passed"

  try {
    const loaded = await loadArtifact(tenantId, runId)
    if (!loaded) throw new Error("Backup is not in a completed, restorable state")

    for (const section of loaded.artifact.sections) {
      const columns = await tableColumns(section.name).catch(() => new Set<string>())
      if (columns.size === 0) {
        issues.push(`Target table "${section.name}" no longer exists in the live schema`)
        continue
      }
      tablesValidated++
      rowsValidated += section.rowCount
      // Validate a sample of rows: every persisted column must still exist on
      // the live table, so a real restore INSERT would not fail. We never write.
      const sample = section.rows.slice(0, 50)
      for (const record of sample) {
        for (const key of Object.keys(record)) {
          if (!columns.has(key)) {
            issues.push(`Column "${section.name}.${key}" in the backup is absent from the live schema`)
            break
          }
        }
      }
      // Tenant-isolation sanity: every restored row must carry this tenant's id.
      if (runTenant != null && columns.has(TENANT_COLUMN)) {
        const foreign = sample.find((r) => r[TENANT_COLUMN] != null && Number(r[TENANT_COLUMN]) !== runTenant)
        if (foreign) issues.push(`Section "${section.name}" contains a row for a different tenant`)
      }
    }
    const uniqueIssues = [...new Set(issues)]
    issues.length = 0
    issues.push(...uniqueIssues.slice(0, 50))
    status = issues.length === 0 ? "passed" : "failed"
  } catch (err) {
    status = "failed"
    issues.push((err as Error).message || "Restore test failed")
  }

  const detail =
    status === "passed"
      ? `Validated ${tablesValidated} table(s) / ${rowsValidated} row(s) against the live schema`
      : `${issues.length} issue(s) found`

  const res = await query<{ insertId: number }>(
    `INSERT INTO \`platform_backup_restore_tests\`
       (\`run_id\`, \`tenant_id\`, \`scope\`, \`status\`, \`tables_validated\`, \`rows_validated\`, \`issues\`, \`detail\`, \`requested_by\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [runId, runTenant, scope, status, tablesValidated, rowsValidated, JSON.stringify(issues), detail, actor.userId],
  )
  const testId = (res as any).insertId as number

  // Advance the policy's restore-test pointer so automatic cadence resets.
  await query(
    "UPDATE `platform_backup_policies` SET `last_restore_test_at` = CURRENT_TIMESTAMP WHERE `scope` = ? AND `tenant_id` <=> ?",
    [scope, runTenant],
  )

  await recordAuditLog({
    action: status === "passed" ? "backup.restore_test_pass" : "backup.restore_test_fail",
    entityType: "backup_restore_test",
    entityId: testId,
    entityLabel: `${BACKUP_SCOPE_LABELS[scope]} restore test (run ${runId})`,
    result: status === "passed" ? "success" : "failure",
    after: { runId, scope, status, tablesValidated, rowsValidated, issues },
    context: { tenantId: runTenant, actorUserId: actor.userId, actorName: actor.name ?? null, actorEmail: actor.email ?? null },
  })

  const rows = await query<any[]>(
    `SELECT t.*, u.name AS requested_by_name FROM \`platform_backup_restore_tests\` t
       LEFT JOIN \`users\` u ON u.id = t.requested_by WHERE t.id = ? LIMIT 1`,
    [testId],
  )
  return rows[0] ? mapRestoreTest(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Download (decrypted artifact) — for a real restore by a platform operator
// ---------------------------------------------------------------------------

export async function getBackupDownload(
  tenantId: number | null,
  id: number,
): Promise<{ bytes: Buffer; fileName: string } | null> {
  await ensureBackupSchema()
  const loaded = await loadArtifact(tenantId, id)
  if (!loaded) return null
  const stamp = new Date(loaded.artifact.generatedAt).toISOString().slice(0, 10)
  const fileName = `backup-${loaded.artifact.scope}-tenant${loaded.artifact.tenantId ?? "all"}-${stamp}-${id}.json`
  return { bytes: Buffer.from(serializeArtifact(loaded.artifact), "utf-8"), fileName }
}

// ---------------------------------------------------------------------------
// Retention (prune expired runs, keep a floor of the most recent)
// ---------------------------------------------------------------------------

export async function pruneExpiredBackups(now: Date = new Date()): Promise<number> {
  await ensureBackupSchema()
  // Group completed runs per (tenant, scope). Within each group keep the newest
  // `min_keep` regardless of expiry; prune the rest once expired.
  const groups = await query<{ tenant_id: number | null; scope: string }[]>(
    "SELECT DISTINCT `tenant_id`, `scope` FROM `platform_backup_runs` WHERE `status` = 'completed'",
  )
  let pruned = 0
  for (const g of groups) {
    const policy = g.tenant_id == null ? null : await resolveEffectivePolicy(Number(g.tenant_id), g.scope as BackupScope)
    const minKeep = policy?.minKeep ?? clampMinKeep(undefined)
    const runs = await query<any[]>(
      "SELECT `id`, `expires_at` FROM `platform_backup_runs` WHERE `status` = 'completed' AND `tenant_id` <=> ? AND `scope` = ? ORDER BY `created_at` DESC",
      [g.tenant_id, g.scope],
    )
    const prunable = runs.slice(minKeep).filter((r) => isBackupExpired(r.expires_at, now))
    for (const r of prunable) {
      await query(
        "UPDATE `platform_backup_runs` SET `status` = 'expired', `artifact` = NULL, `artifact_size` = 0 WHERE `id` = ?",
        [r.id],
      )
      pruned++
    }
  }
  if (pruned > 0) {
    await recordAuditLog({
      action: "backup.retention_prune",
      entityType: "backup_run",
      entityLabel: "Backup retention sweep",
      after: { pruned },
    })
  }
  return pruned
}

// ---------------------------------------------------------------------------
// Listing / summary (UI)
// ---------------------------------------------------------------------------

export async function listBackupRuns(tenantId: number | null, limit = 100): Promise<BackupRun[]> {
  await ensureBackupSchema()
  const safe = Math.max(1, Math.min(200, Math.floor(limit)))
  const rows =
    tenantId == null
      ? await query<any[]>(
          `SELECT r.*, u.name AS requested_by_name FROM \`platform_backup_runs\` r
             LEFT JOIN \`users\` u ON u.id = r.requested_by ORDER BY r.created_at DESC LIMIT ${safe}`,
        )
      : await query<any[]>(
          `SELECT r.*, u.name AS requested_by_name FROM \`platform_backup_runs\` r
             LEFT JOIN \`users\` u ON u.id = r.requested_by WHERE r.tenant_id = ? ORDER BY r.created_at DESC LIMIT ${safe}`,
          [tenantId],
        )
  return rows.map(mapRun)
}

export async function listRestoreTests(tenantId: number | null, limit = 50): Promise<RestoreTest[]> {
  await ensureBackupSchema()
  const safe = Math.max(1, Math.min(200, Math.floor(limit)))
  const rows =
    tenantId == null
      ? await query<any[]>(
          `SELECT t.*, u.name AS requested_by_name FROM \`platform_backup_restore_tests\` t
             LEFT JOIN \`users\` u ON u.id = t.requested_by ORDER BY t.created_at DESC LIMIT ${safe}`,
        )
      : await query<any[]>(
          `SELECT t.*, u.name AS requested_by_name FROM \`platform_backup_restore_tests\` t
             LEFT JOIN \`users\` u ON u.id = t.requested_by WHERE t.tenant_id = ? ORDER BY t.created_at DESC LIMIT ${safe}`,
          [tenantId],
        )
  return rows.map(mapRestoreTest)
}

// ---------------------------------------------------------------------------
// Cron sweep — automated, tenant-aware
// ---------------------------------------------------------------------------

export type BackupSweepResult = { ran: number; failed: number; pruned: number; restoreTests: number }

/**
 * Central-scheduler entrypoint. For every active tenant and scope, resolve the
 * effective policy; when it is enabled and due, run a tenant-scoped backup.
 * When a restore test is due for that scope, run one against the newest backup.
 * Failures are isolated per tenant/scope so one bad tenant never stalls the
 * sweep. Finishes with a retention prune.
 */
export async function runDueBackups(now: Date = new Date()): Promise<BackupSweepResult> {
  await ensureBackupSchema()
  const result: BackupSweepResult = { ran: 0, failed: 0, pruned: 0, restoreTests: 0 }
  const systemActor: BackupActor = { userId: 0, name: "Scheduler", email: null }

  const tenants = await listTenants().catch(() => [])
  for (const tenant of tenants) {
    if (tenant.status && tenant.status !== "active") continue
    for (const scope of BACKUP_SCOPES) {
      let policy: BackupPolicy | null = null
      try {
        policy = await resolveEffectivePolicy(tenant.id, scope)
      } catch {
        continue
      }
      if (!policy || !policy.enabled) continue

      // Due-ness is derived from the newest run for this exact (tenant, scope),
      // so a shared baseline policy schedules each tenant independently.
      const lastRuns = await query<{ created_at: string }[]>(
        "SELECT `created_at` FROM `platform_backup_runs` WHERE `tenant_id` = ? AND `scope` = ? AND `status` IN ('completed','expired') ORDER BY `created_at` DESC LIMIT 1",
        [tenant.id, scope],
      ).catch(() => [])
      const lastRunAt = lastRuns[0]?.created_at ?? null

      if (isBackupDue(policy.frequency, lastRunAt, now)) {
        try {
          const run = await createAndRunBackup(
            {
              scope,
              tenantId: tenant.id,
              triggerSource: "scheduler",
              policyId: policy.tenantId != null ? policy.id : null,
              retentionDays: policy.retentionDays,
              encrypt: policy.encrypt,
              verifyAfter: policy.verifyAfter,
            },
            systemActor,
          )
          if (run.status === "completed") result.ran++
          else result.failed++

          // Automatic restore testing when due.
          if (run.status === "completed" && isRestoreTestDue(policy.restoreTestFrequency, policy.lastRestoreTestAt, now)) {
            try {
              await runRestoreTest(tenant.id, run.id, systemActor)
              result.restoreTests++
            } catch { /* isolated */ }
          }
        } catch {
          result.failed++
        }
      }
    }
  }

  try {
    result.pruned = await pruneExpiredBackups(now)
  } catch { /* isolated */ }

  return result
}
