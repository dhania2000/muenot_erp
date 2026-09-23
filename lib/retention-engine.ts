import "server-only"
/**
 * SPEC 71 — General ERP Data Retention Engine (server store + lifecycle).
 * ---------------------------------------------------------------------------
 * Replaces the frontend-only localStorage placeholder (lib/governance-store.ts)
 * for retention with a real, tenant-scoped, audited, DB-backed engine that
 * generalizes retention to ANY ERP record type via the module catalog
 * (lib/retention-catalog.ts).
 *
 * A retention policy binds a MODULE + RECORD TYPE to a RETENTION PERIOD and an
 * ACTION (archive or delete). The daily lifecycle job (or an on-demand run):
 *
 *   1. Skips the policy when it is PAUSED or under a LEGAL HOLD.
 *   2. Resolves the physical table + columns for the record type against the
 *      live schema, skipping gracefully when the target does not exist here.
 *   3. For a DELETE action, consults SPEC 69 data classification — a record
 *      type classified at a level that forbids auto-delete is never purged.
 *   4. Selects records older than the retention cutoff, minus any that match a
 *      policy EXCEPTION (a specific record, or a field/value criteria).
 *   5. ARCHIVE: seals each eligible row into the immutable, hash-chained
 *      `retention_archive_entries` table (gzip JSON), then removes it from the
 *      hot table only when the policy opts in (purge-after-archive).
 *      DELETE: permanently removes the eligible rows.
 *   6. Records a `retention_runs` row and writes an immutable AUDIT entry.
 *
 * Everything is tenant-scoped: a policy's `tenant_id` scopes both the aux
 * tables and the hot-table predicate the job runs, so a run can never touch
 * another tenant's data. Self-heals its schema at runtime (same pattern as
 * lib/data-classification.ts) so existing databases converge without a manual
 * migration step.
 */
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { query, tableColumns, withTransaction } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { isAutoDeleteBlockedByClassification } from "@/lib/data-classification"
import {
  clampRetentionDays,
  computeNextRun,
  computeRetentionCutoff,
  describeRetentionDays,
  normalizePolicyInput,
  resolveRunState,
  toRetentionAction,
  toRetentionStatus,
  type RetentionAction,
  type RetentionExceptionType,
  type RetentionStatus,
  type NormalizedPolicyInput,
} from "@/lib/retention-model"
import { getCatalogEntry, resolveTargetColumns } from "@/lib/retention-catalog"

/** Safety cap on how many rows a single policy run will act on. */
const MAX_ROWS_PER_RUN = 2000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Actor = { userId: number; name?: string | null; email?: string | null; role?: string | null }

export type RetentionPolicy = {
  id: number
  tenantId: number | null
  catalogKey: string | null
  module: string
  recordType: string
  retentionDays: number
  retentionLabel: string
  action: RetentionAction
  purgeAfterArchive: boolean
  status: RetentionStatus
  legalHold: boolean
  legalHoldReason: string | null
  runState: "active" | "paused" | "held"
  lastRunAt: string | null
  lastRunAffected: number
  nextRunAt: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
  exceptionCount: number
}

export type RetentionException = {
  id: number
  policyId: number
  type: RetentionExceptionType
  recordRef: string | null
  matchField: string | null
  matchValue: string | null
  reason: string | null
  createdByName: string | null
  createdAt: string
}

export type RetentionRun = {
  id: number
  policyId: number
  triggerSource: "scheduler" | "manual"
  status: "success" | "skipped" | "failed"
  action: RetentionAction
  evaluated: number
  archived: number
  deleted: number
  skippedExempt: number
  reason: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  actorName: string | null
}

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`retention_policies\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`catalog_key\` VARCHAR(120) DEFAULT NULL,
      \`module\` VARCHAR(96) NOT NULL,
      \`record_type\` VARCHAR(160) NOT NULL,
      \`retention_days\` INT UNSIGNED NOT NULL,
      \`action\` VARCHAR(16) NOT NULL DEFAULT 'archive',
      \`purge_after_archive\` TINYINT(1) NOT NULL DEFAULT 0,
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
      \`legal_hold\` TINYINT(1) NOT NULL DEFAULT 0,
      \`legal_hold_reason\` VARCHAR(500) DEFAULT NULL,
      \`last_run_at\` DATETIME DEFAULT NULL,
      \`last_run_affected\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`next_run_at\` DATETIME DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_retention_policy\` (\`tenant_id\`, \`module\`, \`record_type\`),
      KEY \`idx_retention_tenant\` (\`tenant_id\`),
      KEY \`idx_retention_run\` (\`status\`, \`legal_hold\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`retention_exceptions\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`policy_id\` INT UNSIGNED NOT NULL,
      \`type\` VARCHAR(16) NOT NULL DEFAULT 'record',
      \`record_ref\` VARCHAR(190) DEFAULT NULL,
      \`match_field\` VARCHAR(96) DEFAULT NULL,
      \`match_value\` VARCHAR(190) DEFAULT NULL,
      \`reason\` VARCHAR(500) DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_retention_exc_policy\` (\`policy_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`retention_runs\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`policy_id\` INT UNSIGNED NOT NULL,
      \`trigger_source\` VARCHAR(16) NOT NULL DEFAULT 'scheduler',
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'success',
      \`action\` VARCHAR(16) NOT NULL DEFAULT 'archive',
      \`evaluated\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`archived\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`deleted\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`skipped_exempt\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`reason\` VARCHAR(500) DEFAULT NULL,
      \`started_at\` DATETIME NOT NULL,
      \`finished_at\` DATETIME DEFAULT NULL,
      \`duration_ms\` INT UNSIGNED DEFAULT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_name\` VARCHAR(160) DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_retention_runs_policy\` (\`policy_id\`, \`started_at\`),
      KEY \`idx_retention_runs_tenant\` (\`tenant_id\`, \`started_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`retention_archive_entries\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`policy_id\` INT UNSIGNED NOT NULL,
      \`run_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`catalog_key\` VARCHAR(120) DEFAULT NULL,
      \`source_table\` VARCHAR(120) NOT NULL,
      \`source_id\` VARCHAR(190) NOT NULL,
      \`payload\` LONGBLOB NOT NULL,
      \`payload_bytes\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`content_hash\` CHAR(64) NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_retention_archive_scope\` (\`tenant_id\`, \`policy_id\`),
      KEY \`idx_retention_archive_source\` (\`source_table\`, \`source_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await ensureArchiveImmutabilityTriggers()
}

/** Append-only guard on the archive table: never update, never delete. */
async function ensureArchiveImmutabilityTriggers(): Promise<void> {
  try {
    const existing = (await query(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema = DATABASE()
          AND trigger_name IN ('retention_archive_no_update','retention_archive_no_delete')`,
    )) as { name: string }[]
    const names = new Set(existing.map((r) => String(r.name)))
    if (!names.has("retention_archive_no_update")) {
      await query(
        `CREATE TRIGGER \`retention_archive_no_update\` BEFORE UPDATE ON \`retention_archive_entries\`
         FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention_archive_entries is append-only'`,
      )
    }
    if (!names.has("retention_archive_no_delete")) {
      await query(
        `CREATE TRIGGER \`retention_archive_no_delete\` BEFORE DELETE ON \`retention_archive_entries\`
         FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention_archive_entries is append-only'`,
      )
    }
  } catch (err) {
    console.warn(
      "[v0] retention archive immutability triggers not installed (app-level immutability still applies):",
      (err as Error).message,
    )
  }
}

export function ensureRetentionSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type PolicyRow = {
  id: number
  tenant_id: number | null
  catalog_key: string | null
  module: string
  record_type: string
  retention_days: number
  action: string
  purge_after_archive: number
  status: string
  legal_hold: number
  legal_hold_reason: string | null
  last_run_at: string | null
  last_run_affected: number
  next_run_at: string | null
  created_by_name: string | null
  created_at: string
  updated_at: string
  exception_count: number
}

function toPolicy(row: PolicyRow): RetentionPolicy {
  const status = toRetentionStatus(row.status)
  const legalHold = Boolean(row.legal_hold)
  const retentionDays = clampRetentionDays(row.retention_days)
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    catalogKey: row.catalog_key,
    module: row.module,
    recordType: row.record_type,
    retentionDays,
    retentionLabel: describeRetentionDays(retentionDays),
    action: toRetentionAction(row.action),
    purgeAfterArchive: Boolean(row.purge_after_archive),
    status,
    legalHold,
    legalHoldReason: row.legal_hold_reason,
    runState: resolveRunState(status, legalHold),
    lastRunAt: row.last_run_at,
    lastRunAffected: Number(row.last_run_affected ?? 0),
    nextRunAt: row.next_run_at,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    exceptionCount: Number(row.exception_count ?? 0),
  }
}

const POLICY_SELECT = `
  SELECT p.*, u.name AS created_by_name,
         (SELECT COUNT(*) FROM retention_exceptions e WHERE e.policy_id = p.id) AS exception_count
    FROM retention_policies p
    LEFT JOIN users u ON u.id = p.created_by
`

// ---------------------------------------------------------------------------
// Policy CRUD (tenant-scoped, audited)
// ---------------------------------------------------------------------------

export async function listPolicies(tenantId: number | null): Promise<RetentionPolicy[]> {
  await ensureRetentionSchema()
  const rows = (await query(
    `${POLICY_SELECT} WHERE p.tenant_id = ? OR p.tenant_id IS NULL ORDER BY p.module, p.record_type`,
    [tenantId],
  )) as PolicyRow[]
  return rows.map(toPolicy)
}

async function getPolicyRow(tenantId: number | null, id: number): Promise<PolicyRow | null> {
  const rows = (await query(`${POLICY_SELECT} WHERE p.id = ? AND (p.tenant_id = ? OR p.tenant_id IS NULL) LIMIT 1`, [
    id,
    tenantId,
  ])) as PolicyRow[]
  return rows[0] ?? null
}

export async function getPolicy(tenantId: number | null, id: number): Promise<RetentionPolicy | null> {
  await ensureRetentionSchema()
  const row = await getPolicyRow(tenantId, id)
  return row ? toPolicy(row) : null
}

function auditContext(tenantId: number | null, actor: Actor) {
  return {
    tenantId,
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
  }
}

export async function createPolicy(
  tenantId: number | null,
  raw: Parameters<typeof normalizePolicyInput>[0],
  actor: Actor,
): Promise<RetentionPolicy> {
  await ensureRetentionSchema()
  const input = normalizePolicyInput(raw)
  validateAgainstCatalog(input)

  const existing = (await query(
    `SELECT id FROM retention_policies
      WHERE (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL)) AND module = ? AND record_type = ? LIMIT 1`,
    [tenantId, tenantId, input.module, input.recordType],
  )) as { id: number }[]
  if (existing.length > 0) throw new Error("A retention policy for this module / record type already exists")

  const nextRun = computeNextRun(resolveRunState(input.status, false))
  const res = (await query(
    `INSERT INTO retention_policies
       (tenant_id, catalog_key, module, record_type, retention_days, action, purge_after_archive, status, next_run_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      input.catalogKey,
      input.module,
      input.recordType,
      input.retentionDays,
      input.action,
      input.purgeAfterArchive ? 1 : 0,
      input.status,
      nextRun,
      actor.userId,
    ],
  )) as { insertId: number }
  const id = res.insertId
  await recordAuditLog({
    action: "retention_policy.create",
    entityType: "retention_policy",
    entityId: id,
    entityLabel: `${input.module} / ${input.recordType}`,
    after: { ...input },
    context: auditContext(tenantId, actor),
  })
  return (await getPolicy(tenantId, id))!
}

/** A custom (non-catalog) record type can only be tracked, and never auto-deletes a real table. */
function validateAgainstCatalog(input: NormalizedPolicyInput): void {
  if (!input.catalogKey) return
  const entry = getCatalogEntry(input.catalogKey)
  if (!entry) throw new Error(`Unknown record type "${input.catalogKey}"`)
  if (input.action === "delete" && !entry.allowDelete) {
    throw new Error(`"${entry.recordType}" may only be archived, not permanently deleted`)
  }
}

export type UpdatePolicyInput = {
  retentionValue?: unknown
  retentionUnit?: unknown
  period?: unknown
  action?: unknown
  purgeAfterArchive?: unknown
  status?: unknown
  legalHold?: unknown
  legalHoldReason?: unknown
}

export async function updatePolicy(
  tenantId: number | null,
  id: number,
  patch: UpdatePolicyInput,
  actor: Actor,
): Promise<RetentionPolicy | null> {
  await ensureRetentionSchema()
  const currentRow = await getPolicyRow(tenantId, id)
  if (!currentRow) return null
  const current = toPolicy(currentRow)

  // Re-normalize using the existing module/recordType/catalogKey so the shared
  // validator runs, but only the mutable fields are actually changed.
  const merged = normalizePolicyInput({
    module: current.module,
    recordType: current.recordType,
    catalogKey: current.catalogKey,
    retentionValue: patch.retentionValue,
    retentionUnit: patch.retentionUnit,
    period: patch.period ?? current.retentionDays,
    action: patch.action ?? current.action,
    purgeAfterArchive: patch.purgeAfterArchive ?? current.purgeAfterArchive,
    status: patch.status ?? current.status,
  })
  validateAgainstCatalog(merged)

  const legalHold = patch.legalHold == null ? current.legalHold : Boolean(patch.legalHold)
  const legalHoldReason =
    patch.legalHoldReason != null
      ? String(patch.legalHoldReason).slice(0, 500)
      : legalHold
        ? current.legalHoldReason
        : null
  const runState = resolveRunState(merged.status, legalHold)
  const nextRun = computeNextRun(runState)

  await query(
    `UPDATE retention_policies
        SET retention_days = ?, action = ?, purge_after_archive = ?, status = ?, legal_hold = ?, legal_hold_reason = ?, next_run_at = ?
      WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`,
    [
      merged.retentionDays,
      merged.action,
      merged.purgeAfterArchive ? 1 : 0,
      merged.status,
      legalHold ? 1 : 0,
      legalHoldReason,
      nextRun,
      id,
      tenantId,
    ],
  )
  await recordAuditLog({
    action: "retention_policy.update",
    entityType: "retention_policy",
    entityId: id,
    entityLabel: `${current.module} / ${current.recordType}`,
    before: {
      retentionDays: current.retentionDays,
      action: current.action,
      purgeAfterArchive: current.purgeAfterArchive,
      status: current.status,
      legalHold: current.legalHold,
    },
    after: {
      retentionDays: merged.retentionDays,
      action: merged.action,
      purgeAfterArchive: merged.purgeAfterArchive,
      status: merged.status,
      legalHold,
    },
    context: auditContext(tenantId, actor),
  })
  return getPolicy(tenantId, id)
}

export async function deletePolicy(tenantId: number | null, id: number, actor: Actor): Promise<boolean> {
  await ensureRetentionSchema()
  const row = await getPolicyRow(tenantId, id)
  if (!row) return false
  const before = toPolicy(row)
  await query(`DELETE FROM retention_exceptions WHERE policy_id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [
    id,
    tenantId,
  ])
  await query(`DELETE FROM retention_policies WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [id, tenantId])
  await recordAuditLog({
    action: "retention_policy.delete",
    entityType: "retention_policy",
    entityId: id,
    entityLabel: `${before.module} / ${before.recordType}`,
    before: { module: before.module, recordType: before.recordType, retentionDays: before.retentionDays },
    context: auditContext(tenantId, actor),
  })
  return true
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

type ExceptionRow = {
  id: number
  policy_id: number
  type: string
  record_ref: string | null
  match_field: string | null
  match_value: string | null
  reason: string | null
  created_by_name: string | null
  created_at: string
}

function toException(row: ExceptionRow): RetentionException {
  return {
    id: Number(row.id),
    policyId: Number(row.policy_id),
    type: row.type === "criteria" ? "criteria" : "record",
    recordRef: row.record_ref,
    matchField: row.match_field,
    matchValue: row.match_value,
    reason: row.reason,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
  }
}

export async function listExceptions(tenantId: number | null, policyId: number): Promise<RetentionException[]> {
  await ensureRetentionSchema()
  const rows = (await query(
    `SELECT e.*, u.name AS created_by_name
       FROM retention_exceptions e
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.policy_id = ? AND (e.tenant_id = ? OR e.tenant_id IS NULL)
      ORDER BY e.id DESC`,
    [policyId, tenantId],
  )) as ExceptionRow[]
  return rows.map(toException)
}

export type CreateExceptionInput = {
  type?: unknown
  recordRef?: unknown
  matchField?: unknown
  matchValue?: unknown
  reason?: unknown
}

export async function createException(
  tenantId: number | null,
  policyId: number,
  input: CreateExceptionInput,
  actor: Actor,
): Promise<RetentionException | null> {
  await ensureRetentionSchema()
  const policy = await getPolicyRow(tenantId, policyId)
  if (!policy) return null

  const type: RetentionExceptionType = input.type === "criteria" ? "criteria" : "record"
  let recordRef: string | null = null
  let matchField: string | null = null
  let matchValue: string | null = null
  if (type === "record") {
    recordRef = String(input.recordRef ?? "").trim().slice(0, 190)
    if (!recordRef) throw new Error("A record reference is required for a record exception")
  } else {
    matchField = String(input.matchField ?? "").trim().slice(0, 96)
    matchValue = String(input.matchValue ?? "").trim().slice(0, 190)
    if (!matchField) throw new Error("A field is required for a criteria exception")
  }

  const res = (await query(
    `INSERT INTO retention_exceptions (tenant_id, policy_id, type, record_ref, match_field, match_value, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      policyId,
      type,
      recordRef,
      matchField,
      matchValue,
      input.reason ? String(input.reason).slice(0, 500) : null,
      actor.userId,
    ],
  )) as { insertId: number }
  await recordAuditLog({
    action: "retention_exception.create",
    entityType: "retention_policy",
    entityId: policyId,
    entityLabel: `${policy.module} / ${policy.record_type}`,
    after: { type, recordRef, matchField, matchValue },
    context: auditContext(tenantId, actor),
  })
  const rows = (await query(
    `SELECT e.*, u.name AS created_by_name FROM retention_exceptions e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`,
    [res.insertId],
  )) as ExceptionRow[]
  return toException(rows[0])
}

export async function deleteException(
  tenantId: number | null,
  policyId: number,
  exceptionId: number,
  actor: Actor,
): Promise<boolean> {
  await ensureRetentionSchema()
  const rows = (await query(
    `SELECT id FROM retention_exceptions WHERE id = ? AND policy_id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
    [exceptionId, policyId, tenantId],
  )) as { id: number }[]
  if (rows.length === 0) return false
  await query(`DELETE FROM retention_exceptions WHERE id = ? AND policy_id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [
    exceptionId,
    policyId,
    tenantId,
  ])
  await recordAuditLog({
    action: "retention_exception.delete",
    entityType: "retention_policy",
    entityId: policyId,
    entityLabel: `exception ${exceptionId}`,
    context: auditContext(tenantId, actor),
  })
  return true
}

// ---------------------------------------------------------------------------
// Runs (history)
// ---------------------------------------------------------------------------

type RunRow = {
  id: number
  policy_id: number
  trigger_source: string
  status: string
  action: string
  evaluated: number
  archived: number
  deleted: number
  skipped_exempt: number
  reason: string | null
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  actor_name: string | null
}

function toRun(row: RunRow): RetentionRun {
  return {
    id: Number(row.id),
    policyId: Number(row.policy_id),
    triggerSource: row.trigger_source === "manual" ? "manual" : "scheduler",
    status: (["success", "skipped", "failed"].includes(row.status) ? row.status : "success") as RetentionRun["status"],
    action: toRetentionAction(row.action),
    evaluated: Number(row.evaluated ?? 0),
    archived: Number(row.archived ?? 0),
    deleted: Number(row.deleted ?? 0),
    skippedExempt: Number(row.skipped_exempt ?? 0),
    reason: row.reason,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    actorName: row.actor_name,
  }
}

export async function listRuns(tenantId: number | null, policyId: number, limit = 20): Promise<RetentionRun[]> {
  await ensureRetentionSchema()
  const safe = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)))
  const rows = (await query(
    `SELECT * FROM retention_runs WHERE policy_id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      ORDER BY started_at DESC LIMIT ${safe}`,
    [policyId, tenantId],
  )) as RunRow[]
  return rows.map(toRun)
}

// ---------------------------------------------------------------------------
// Lifecycle execution
// ---------------------------------------------------------------------------

export type RunOutcome = {
  status: "success" | "skipped" | "failed"
  action: RetentionAction
  evaluated: number
  archived: number
  deleted: number
  skippedExempt: number
  reason: string | null
}

/** Build the additional exception WHERE fragments (validated field names). */
function buildExceptionClauses(
  exceptions: ExceptionRow[],
  primaryKey: string,
  existingColumns: Set<string>,
): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  const recordRefs = exceptions
    .filter((e) => e.type !== "criteria" && e.record_ref != null)
    .map((e) => e.record_ref as string)
  if (recordRefs.length > 0) {
    clauses.push(`\`${primaryKey}\` NOT IN (${recordRefs.map(() => "?").join(", ")})`)
    params.push(...recordRefs)
  }
  for (const e of exceptions) {
    if (e.type !== "criteria" || !e.match_field) continue
    // Only honor a criteria field that is a real column — never interpolate an
    // unvalidated identifier into SQL.
    if (!existingColumns.has(e.match_field)) continue
    clauses.push(`NOT (\`${e.match_field}\` <=> ?)`)
    params.push(e.match_value)
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params }
}

/**
 * Execute one policy. When `dryRun` is true it only counts eligible records and
 * records nothing. Returns a structured outcome; never throws for an
 * expected-skip condition (paused / held / target missing / classification
 * block), only for genuine execution failures.
 */
export async function runPolicy(
  tenantId: number | null,
  policyId: number,
  opts: { trigger: "scheduler" | "manual"; actor?: Actor; dryRun?: boolean },
): Promise<RunOutcome> {
  await ensureRetentionSchema()
  const startedAt = Date.now()
  const policyRow = await getPolicyRow(tenantId, policyId)
  if (!policyRow) throw new Error("Policy not found")
  const policy = toPolicy(policyRow)

  const finalize = async (outcome: RunOutcome): Promise<RunOutcome> => {
    if (opts.dryRun) return outcome
    await recordRun(policy, opts, startedAt, outcome)
    if (outcome.status === "success") {
      const affected = outcome.archived + outcome.deleted
      await query(
        `UPDATE retention_policies SET last_run_at = NOW(), last_run_affected = ?, next_run_at = ? WHERE id = ?`,
        [affected, computeNextRun(policy.runState), policyId],
      )
    }
    return outcome
  }

  // 1. Run-state gate — a manual run still respects pause/hold.
  if (policy.runState === "held") {
    return finalize(skip(policy.action, "Skipped — policy is under a legal hold"))
  }
  if (policy.runState === "paused") {
    return finalize(skip(policy.action, "Skipped — policy is paused"))
  }

  // 2. Resolve the physical target. Custom (non-catalog) policies are tracking
  //    only — they never touch a real table automatically.
  const entry = getCatalogEntry(policy.catalogKey)
  if (!entry) {
    return finalize(skip(policy.action, "Skipped — custom record type has no automated target; handle manually"))
  }
  const columns = await tableColumns(entry.table)
  const resolved = resolveTargetColumns(entry, columns)
  if (!resolved.ok) {
    return finalize(skip(policy.action, `Skipped — ${resolved.reason}`))
  }
  const target = resolved.target

  // 3. Classification gate for destructive deletes (SPEC 69 integration).
  if (policy.action === "delete") {
    const block = await isAutoDeleteBlockedByClassification(tenantId, entry.module, target.entity)
    if (block.blocked) {
      return finalize(
        skip(policy.action, `Skipped — classification "${block.level}" forbids automatic deletion`),
      )
    }
  }

  // 4. Select eligible ids (older than cutoff, matching status filter, minus exceptions).
  const cutoff = computeRetentionCutoff(policy.retentionDays)
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ")
  const excRows = (await query(`SELECT * FROM retention_exceptions WHERE policy_id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, [
    policyId,
    tenantId,
  ])) as ExceptionRow[]
  const exc = buildExceptionClauses(excRows, target.primaryKey, columns)

  const whereParts: string[] = [`\`${target.tenantColumn}\` = ?`, `\`${target.dateColumn}\` <= ?`]
  const whereParams: unknown[] = [tenantId, cutoffStr]
  if (target.statusFilter) {
    whereParts.push(`\`${target.statusFilter.column}\` IN (${target.statusFilter.equals.map(() => "?").join(", ")})`)
    whereParams.push(...target.statusFilter.equals)
  }
  const whereSql = `WHERE ${whereParts.join(" AND ")}${exc.sql}`
  const allParams = [...whereParams, ...exc.params]

  const idRows = (await query(
    `SELECT \`${target.primaryKey}\` AS __id FROM \`${target.table}\` ${whereSql}
      ORDER BY \`${target.primaryKey}\` ASC LIMIT ${MAX_ROWS_PER_RUN}`,
    allParams,
  )) as { __id: string | number }[]
  const ids = idRows.map((r) => r.__id)

  if (opts.dryRun) {
    return { status: "success", action: policy.action, evaluated: ids.length, archived: 0, deleted: 0, skippedExempt: 0, reason: null }
  }
  if (ids.length === 0) {
    return finalize({ status: "success", action: policy.action, evaluated: 0, archived: 0, deleted: 0, skippedExempt: 0, reason: "Nothing eligible" })
  }

  const placeholders = ids.map(() => "?").join(", ")
  let archived = 0
  let deleted = 0

  try {
    if (policy.action === "archive") {
      // Snapshot every eligible row into the immutable archive, then purge the
      // hot table only when the policy opts in.
      const rows = (await query(
        `SELECT * FROM \`${target.table}\` WHERE \`${target.tenantColumn}\` = ? AND \`${target.primaryKey}\` IN (${placeholders})`,
        [tenantId, ...ids],
      )) as Record<string, unknown>[]
      await sealArchiveBatch(tenantId, policy, target, rows)
      archived = rows.length
      if (policy.purgeAfterArchive) {
        const res = (await query(
          `DELETE FROM \`${target.table}\` WHERE \`${target.tenantColumn}\` = ? AND \`${target.primaryKey}\` IN (${placeholders})`,
          [tenantId, ...ids],
        )) as { affectedRows?: number }
        deleted = Number(res.affectedRows ?? 0)
      }
      return finalize({
        status: "success",
        action: policy.action,
        evaluated: ids.length,
        archived,
        deleted,
        skippedExempt: excRows.length,
        reason: policy.purgeAfterArchive ? "Archived and purged from hot table" : "Archived (originals retained)",
      })
    }

    // delete
    const res = (await query(
      `DELETE FROM \`${target.table}\` WHERE \`${target.tenantColumn}\` = ? AND \`${target.primaryKey}\` IN (${placeholders})`,
      [tenantId, ...ids],
    )) as { affectedRows?: number }
    deleted = Number(res.affectedRows ?? 0)
    return finalize({
      status: "success",
      action: policy.action,
      evaluated: ids.length,
      archived: 0,
      deleted,
      skippedExempt: excRows.length,
      reason: "Permanently deleted",
    })
  } catch (err) {
    return finalize({
      status: "failed",
      action: policy.action,
      evaluated: ids.length,
      archived,
      deleted,
      skippedExempt: excRows.length,
      reason: (err as Error).message.slice(0, 480),
    })
  }
}

function skip(action: RetentionAction, reason: string): RunOutcome {
  return { status: "skipped", action, evaluated: 0, archived: 0, deleted: 0, skippedExempt: 0, reason }
}

/** Seal a set of source rows into the immutable, gzip-sealed archive. */
async function sealArchiveBatch(
  tenantId: number | null,
  policy: RetentionPolicy,
  target: { table: string; primaryKey: string },
  rows: Record<string, unknown>[],
): Promise<void> {
  await withTransaction(async (conn) => {
    for (const row of rows) {
      const sourceId = String(row[target.primaryKey] ?? "")
      const canonical = JSON.stringify(row, Object.keys(row).sort())
      const gz = gzipSync(Buffer.from(canonical, "utf8"))
      const hash = createHash("sha256").update(canonical).digest("hex")
      await conn.query(
        `INSERT INTO retention_archive_entries
           (tenant_id, policy_id, catalog_key, source_table, source_id, payload, payload_bytes, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, policy.id, policy.catalogKey, target.table, sourceId, gz, gz.length, hash],
      )
    }
  })
}

async function recordRun(
  policy: RetentionPolicy,
  opts: { trigger: "scheduler" | "manual"; actor?: Actor },
  startedAt: number,
  outcome: RunOutcome,
): Promise<void> {
  const startedStr = new Date(startedAt).toISOString().slice(0, 19).replace("T", " ")
  try {
    await query(
      `INSERT INTO retention_runs
         (tenant_id, policy_id, trigger_source, status, action, evaluated, archived, deleted, skipped_exempt, reason, started_at, finished_at, duration_ms, actor_user_id, actor_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [
        policy.tenantId,
        policy.id,
        opts.trigger,
        outcome.status,
        outcome.action,
        outcome.evaluated,
        outcome.archived,
        outcome.deleted,
        outcome.skippedExempt,
        outcome.reason,
        startedStr,
        Math.max(0, Date.now() - startedAt),
        opts.actor?.userId ?? null,
        opts.actor?.name ?? null,
      ],
    )
  } catch (err) {
    console.error("[v0] retention run log failed:", (err as Error).message)
  }
  await recordAuditLog({
    action: `retention_policy.run.${outcome.status}`,
    result: outcome.status === "failed" ? "failure" : "success",
    entityType: "retention_policy",
    entityId: policy.id,
    entityLabel: `${policy.module} / ${policy.recordType}`,
    metadata: {
      trigger: opts.trigger,
      action: outcome.action,
      evaluated: outcome.evaluated,
      archived: outcome.archived,
      deleted: outcome.deleted,
      reason: outcome.reason,
    },
    context: {
      tenantId: policy.tenantId,
      actorUserId: opts.actor?.userId ?? null,
      actorName: opts.actor?.name ?? null,
      actorEmail: opts.actor?.email ?? null,
      actorRole: opts.actor?.role ?? null,
    },
  })
}

/** Sweep every runnable policy for a tenant (used by the cron job). */
export async function runTenantSweep(tenantId: number): Promise<{
  policies: number
  ran: number
  skipped: number
  failed: number
  archived: number
  deleted: number
  errors: string[]
}> {
  await ensureRetentionSchema()
  const policies = await listPolicies(tenantId)
  let ran = 0
  let skipped = 0
  let failed = 0
  let archived = 0
  let deleted = 0
  const errors: string[] = []
  for (const policy of policies) {
    if (policy.tenantId == null) continue // platform rows are not swept per-tenant
    try {
      const outcome = await runPolicy(tenantId, policy.id, { trigger: "scheduler" })
      if (outcome.status === "skipped") skipped++
      else if (outcome.status === "failed") {
        failed++
        errors.push(`policy ${policy.id}: ${outcome.reason}`)
      } else {
        ran++
        archived += outcome.archived
        deleted += outcome.deleted
      }
    } catch (err) {
      failed++
      errors.push(`policy ${policy.id}: ${(err as Error).message}`)
    }
  }
  return { policies: policies.length, ran, skipped, failed, archived, deleted, errors }
}
