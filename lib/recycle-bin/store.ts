import "server-only"
/**
 * SPEC 35 — Soft delete, recycle bin, version history & recovery (server store).
 * ---------------------------------------------------------------------------
 * The tenant-scoped, audited data layer behind the pure models in
 * lib/recycle-bin/model.ts (soft delete / restore / purge),
 * lib/recycle-bin/version-model.ts (versioned sensitive edits) and the
 * critical-record allow-list in lib/recycle-bin/registry.ts.
 *
 * DESIGN — reuse, don't duplicate:
 *   • Immutable audit events go through lib/audit-log-store.ts (hash-chained,
 *     append-only) — the same ledger every other subsystem writes to.
 *   • Legal-hold protection is re-checked LIVE against legal_holds /
 *     legal_hold_items using the pure predicate from lib/legal-hold-model.ts.
 *   • Sensitive edits are routed through the configurable Approval Authority
 *     engine (lib/approval-authority.ts), exactly like DMS documents. When no
 *     rule is configured the change falls back to PEER approval by a different
 *     tenant admin — it is never auto-published.
 *
 * SOFT DELETE KEEPS THE ROW IN PLACE. The record gets `deleted_at`,
 * `deleted_by`, `delete_reason`; its primary key and every foreign-key column
 * are untouched, so a restore is reference-preserving by construction. Only an
 * expiry/manual PURGE physically removes the row, and only when nothing still
 * references it.
 *
 * Every table/column identifier in dynamic SQL comes from the registry, never
 * from input. Every statement is filtered by the caller's tenant_id.
 */
import { createHash } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import { isRecordHeld, type LegalHoldItemMatch, type PolicyTarget } from "@/lib/legal-hold-model"
import { actOnApprovalRequest, raiseApprovalRequest } from "@/lib/approval-authority"
import { getClientLinkCounts } from "@/lib/clients-db"
import {
  clampRestoreWindowDays,
  computeRestoreDeadline,
  evaluatePurge,
  evaluateRestore,
  normalizeDeleteReason,
  DEFAULT_RESTORE_WINDOW_DAYS,
  type RecycleEntryStatus,
} from "@/lib/recycle-bin/model"
import {
  evaluateTransition,
  isLiveRowStale,
  nextVersionNo,
  normalizeDecisionNote,
  RECORD_VERSION_LIMITS,
  type RecordVersionStatus,
} from "@/lib/recycle-bin/version-model"
import {
  entityLabel,
  gatedChanges,
  getCriticalEntity,
  listCriticalEntities,
  parseEntityPk,
  sanitizePolicyFields,
  validateFieldValue,
  valuesEqual,
  type CriticalEntityDef,
} from "@/lib/recycle-bin/registry"

export type Actor = { userId: number; name?: string | null; email?: string | null; role?: string | null }

export type Failure = { ok: false; code: string; message: string; status: number }
const fail = (code: string, message: string, status: number): Failure => ({ ok: false, code, message, status })

/** Thrown inside a transaction to roll it back and surface a clean API error. */
class StoreConflict extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

const MIN_REASON_LENGTH = 3

type Row = Record<string, unknown>
type Conn = { query: (sql: string, params?: unknown[]) => Promise<unknown> }

async function connRows(conn: Conn, sql: string, params: unknown[]): Promise<Row[]> {
  const res = (await conn.query(sql, params)) as [Row[] | { affectedRows?: number }, unknown]
  return Array.isArray(res?.[0]) ? (res[0] as Row[]) : []
}
async function connExec(conn: Conn, sql: string, params: unknown[]): Promise<{ affectedRows: number; insertId: number }> {
  const res = (await conn.query(sql, params)) as [{ affectedRows?: number; insertId?: number }, unknown]
  return { affectedRows: Number(res?.[0]?.affectedRows ?? 0), insertId: Number(res?.[0]?.insertId ?? 0) }
}

function errno(err: unknown): number {
  return Number((err as { errno?: number })?.errno ?? 0)
}

// ---------------------------------------------------------------------------
// Schema (self-healing; mirrors database/migrations/20260926_spec35_*.sql)
// ---------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = (await query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )) as Array<{ c: number }>
  return Number(rows?.[0]?.c ?? 0) > 0
}

async function addColumnIfMissing(table: string, column: string, ddl: string): Promise<void> {
  if (!(await columnExists(table, column))) await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`)
}

export function ensureRecycleBinSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS \`recycle_bin_entries\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`entity_type\` VARCHAR(120) NOT NULL,
          \`entity_table\` VARCHAR(120) NOT NULL,
          \`entity_pk\` VARCHAR(190) NOT NULL,
          \`entity_label\` VARCHAR(255) DEFAULT NULL,
          \`module\` VARCHAR(96) DEFAULT NULL,
          \`snapshot\` MEDIUMTEXT NOT NULL,
          \`snapshot_hash\` CHAR(64) DEFAULT NULL,
          \`reason\` VARCHAR(1000) DEFAULT NULL,
          \`status\` ENUM('recycled','restored','purged') NOT NULL DEFAULT 'recycled',
          \`legal_hold\` TINYINT(1) NOT NULL DEFAULT 0,
          \`deleted_by\` INT UNSIGNED DEFAULT NULL,
          \`deleted_by_name\` VARCHAR(190) DEFAULT NULL,
          \`deleted_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`restore_deadline\` DATETIME DEFAULT NULL,
          \`restored_by\` INT UNSIGNED DEFAULT NULL,
          \`restored_at\` DATETIME DEFAULT NULL,
          \`restore_key\` VARCHAR(128) DEFAULT NULL,
          \`purged_by\` INT UNSIGNED DEFAULT NULL,
          \`purged_at\` DATETIME DEFAULT NULL,
          \`idempotency_key\` VARCHAR(128) DEFAULT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uniq_recycle_idem\` (\`tenant_id\`, \`idempotency_key\`),
          KEY \`idx_recycle_tenant_status\` (\`tenant_id\`, \`status\`),
          KEY \`idx_recycle_entity\` (\`tenant_id\`, \`entity_type\`, \`entity_pk\`),
          KEY \`idx_recycle_deadline\` (\`status\`, \`restore_deadline\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)
      await addColumnIfMissing("recycle_bin_entries", "snapshot_hash", "`snapshot_hash` CHAR(64) DEFAULT NULL")
      await addColumnIfMissing("recycle_bin_entries", "restore_key", "`restore_key` VARCHAR(128) DEFAULT NULL")

      await query(`
        CREATE TABLE IF NOT EXISTS \`recycle_bin_settings\` (
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`restore_window_days\` INT UNSIGNED NOT NULL DEFAULT ${DEFAULT_RESTORE_WINDOW_DAYS},
          \`updated_by\` INT UNSIGNED DEFAULT NULL,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`tenant_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)

      await query(`
        CREATE TABLE IF NOT EXISTS \`record_versions\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`entity_type\` VARCHAR(120) NOT NULL,
          \`entity_pk\` VARCHAR(190) NOT NULL,
          \`version_no\` INT UNSIGNED NOT NULL,
          \`base_version_no\` INT UNSIGNED NOT NULL DEFAULT 0,
          \`base_row_version\` INT UNSIGNED DEFAULT NULL,
          \`status\` ENUM('draft','pending','approved','published','rejected','superseded') NOT NULL DEFAULT 'draft',
          \`payload\` MEDIUMTEXT NOT NULL,
          \`base_values\` MEDIUMTEXT DEFAULT NULL,
          \`before_values\` MEDIUMTEXT DEFAULT NULL,
          \`summary\` VARCHAR(500) DEFAULT NULL,
          \`revert_of_version_id\` BIGINT UNSIGNED DEFAULT NULL,
          \`approval_mode\` ENUM('engine','peer') DEFAULT NULL,
          \`approval_request_id\` BIGINT UNSIGNED DEFAULT NULL,
          \`created_by\` INT UNSIGNED DEFAULT NULL,
          \`created_by_name\` VARCHAR(190) DEFAULT NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`submitted_at\` DATETIME DEFAULT NULL,
          \`decided_by\` INT UNSIGNED DEFAULT NULL,
          \`decided_by_name\` VARCHAR(190) DEFAULT NULL,
          \`decided_at\` DATETIME DEFAULT NULL,
          \`decision_note\` VARCHAR(500) DEFAULT NULL,
          \`published_by\` INT UNSIGNED DEFAULT NULL,
          \`published_at\` DATETIME DEFAULT NULL,
          \`idempotency_key\` VARCHAR(128) DEFAULT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uniq_version_no\` (\`tenant_id\`, \`entity_type\`, \`entity_pk\`, \`version_no\`),
          UNIQUE KEY \`uniq_version_idem\` (\`tenant_id\`, \`idempotency_key\`),
          KEY \`idx_version_entity\` (\`tenant_id\`, \`entity_type\`, \`entity_pk\`),
          KEY \`idx_version_status\` (\`tenant_id\`, \`status\`),
          KEY \`idx_version_approval\` (\`tenant_id\`, \`approval_request_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)
      for (const [col, ddl] of [
        ["base_row_version", "`base_row_version` INT UNSIGNED DEFAULT NULL"],
        ["base_values", "`base_values` MEDIUMTEXT DEFAULT NULL"],
        ["before_values", "`before_values` MEDIUMTEXT DEFAULT NULL"],
        ["revert_of_version_id", "`revert_of_version_id` BIGINT UNSIGNED DEFAULT NULL"],
        ["approval_mode", "`approval_mode` ENUM('engine','peer') DEFAULT NULL"],
        ["approval_request_id", "`approval_request_id` BIGINT UNSIGNED DEFAULT NULL"],
        ["published_by", "`published_by` INT UNSIGNED DEFAULT NULL"],
      ] as const) {
        await addColumnIfMissing("record_versions", col, ddl)
      }

      await query(`
        CREATE TABLE IF NOT EXISTS \`record_version_policies\` (
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`entity_type\` VARCHAR(120) NOT NULL,
          \`fields\` TEXT NOT NULL,
          \`updated_by\` INT UNSIGNED DEFAULT NULL,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`tenant_id\`, \`entity_type\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)

      // The consistent soft-delete trio on every critical table. A table that
      // does not exist yet is skipped; its own ensure step creates it later.
      for (const def of listCriticalEntities()) {
        try {
          await addColumnIfMissing(def.table, "deleted_at", "`deleted_at` DATETIME DEFAULT NULL")
          await addColumnIfMissing(def.table, "deleted_by", "`deleted_by` INT UNSIGNED DEFAULT NULL")
          await addColumnIfMissing(def.table, "delete_reason", "`delete_reason` VARCHAR(1000) DEFAULT NULL")
        } catch (err) {
          console.error(`[recycle-bin] soft-delete columns on ${def.table} failed:`, (err as Error).message)
        }
      }
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

// ---------------------------------------------------------------------------
// Live legal-hold re-check
// ---------------------------------------------------------------------------

export async function isRecordUnderLegalHold(
  tenantId: number,
  opts: { entityType: string; entityPk: string; module: string | null; fields?: Record<string, unknown> },
): Promise<boolean> {
  let rows: Row[]
  try {
    rows = (await query(
      `SELECT i.scope, i.module, i.catalog_key, i.record_type, i.record_ref, i.match_field, i.match_value, i.file_id
         FROM legal_hold_items i
         JOIN legal_holds h ON h.id = i.hold_id AND h.tenant_id = i.tenant_id
        WHERE i.tenant_id = ? AND h.status = 'active'`,
      [tenantId],
    )) as Row[]
  } catch (err) {
    // The legal-hold tables may not exist yet on a fresh tenant — nothing can be
    // held then. Any OTHER failure must fail closed (treated as held).
    if (errno(err) === 1146) return false
    console.error("[recycle-bin] legal-hold check failed; failing closed:", (err as Error).message)
    return true
  }
  if (!Array.isArray(rows) || rows.length === 0) return false

  const items: LegalHoldItemMatch[] = rows.map((r) => ({
    scope: String(r.scope) as LegalHoldItemMatch["scope"],
    module: (r.module as string) ?? null,
    catalogKey: (r.catalog_key as string) ?? null,
    recordType: (r.record_type as string) ?? null,
    recordRef: (r.record_ref as string) ?? null,
    matchField: (r.match_field as string) ?? null,
    matchValue: (r.match_value as string) ?? null,
    fileId: r.file_id == null ? null : Number(r.file_id),
  }))
  const policy: PolicyTarget = { module: opts.module ?? "", catalogKey: opts.entityType, recordType: opts.entityType }
  return isRecordHeld(items, policy, { id: opts.entityPk, fields: opts.fields ?? {} })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getRestoreWindowDays(tenantId: number): Promise<number> {
  await ensureRecycleBinSchema()
  const rows = (await query(`SELECT restore_window_days FROM recycle_bin_settings WHERE tenant_id = ? LIMIT 1`, [
    tenantId,
  ])) as Row[]
  return rows.length ? clampRestoreWindowDays(rows[0].restore_window_days) : DEFAULT_RESTORE_WINDOW_DAYS
}

export async function setRestoreWindowDays(
  tenantId: number,
  days: unknown,
  actor: Actor,
  audit?: AuditContext,
): Promise<number> {
  await ensureRecycleBinSchema()
  const n = Math.floor(Number(days))
  if (!Number.isFinite(n)) throw new StoreConflict("INVALID", "restoreWindowDays must be a number", 400)
  const value = clampRestoreWindowDays(n)
  const before = await getRestoreWindowDays(tenantId)
  await query(
    `INSERT INTO recycle_bin_settings (tenant_id, restore_window_days, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE restore_window_days = VALUES(restore_window_days), updated_by = VALUES(updated_by)`,
    [tenantId, value, actor.userId],
  )
  await recordAuditLog(
    {
      action: "recycle_bin.settings_update",
      entityType: "recycle_bin_settings",
      entityId: String(tenantId),
      before: { restoreWindowDays: before },
      after: { restoreWindowDays: value },
    },
    audit,
  )
  return value
}

export async function getApprovalPolicy(tenantId: number, entityType: string): Promise<string[]> {
  const def = getCriticalEntity(entityType)
  if (!def) return []
  await ensureRecycleBinSchema()
  const rows = (await query(
    `SELECT fields FROM record_version_policies WHERE tenant_id = ? AND entity_type = ? LIMIT 1`,
    [tenantId, def.entityType],
  )) as Row[]
  if (!rows.length) return [...def.defaultApprovalFields]
  let parsed: unknown = []
  try {
    parsed = JSON.parse(String(rows[0].fields))
  } catch {
    // A corrupt policy fails closed onto the platform defaults.
    return [...def.defaultApprovalFields]
  }
  return sanitizePolicyFields(def, parsed)
}

export async function setApprovalPolicy(
  tenantId: number,
  entityType: string,
  fields: unknown,
  actor: Actor,
  audit?: AuditContext,
): Promise<string[] | Failure> {
  const def = getCriticalEntity(entityType)
  if (!def) return fail("UNKNOWN_ENTITY", "Unknown entity type", 400)
  if (!Array.isArray(fields)) return fail("INVALID", "fields must be an array", 400)
  const clean = sanitizePolicyFields(def, fields)
  const rejected = fields.filter((f) => typeof f !== "string" || !def.versionedFields[f])
  if (rejected.length) return fail("FIELD_NOT_VERSIONABLE", `Not versionable: ${rejected.join(", ")}`, 400)
  const before = await getApprovalPolicy(tenantId, def.entityType)
  await query(
    `INSERT INTO record_version_policies (tenant_id, entity_type, fields, updated_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE fields = VALUES(fields), updated_by = VALUES(updated_by)`,
    [tenantId, def.entityType, JSON.stringify(clean), actor.userId],
  )
  await recordAuditLog(
    {
      action: "record_version.policy_update",
      entityType: "record_version_policy",
      entityId: def.entityType,
      before: { fields: before },
      after: { fields: clean },
    },
    audit,
  )
  return clean
}

/**
 * Which approval-gated fields a direct edit would change. Callers (e.g. PATCH
 * /api/clients/[id]) must reject a non-empty result with APPROVAL_REQUIRED.
 */
export async function findGatedChanges(
  tenantId: number,
  entityType: string,
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<string[]> {
  const def = getCriticalEntity(entityType)
  if (!def) return []
  const gated = await getApprovalPolicy(tenantId, def.entityType)
  return gatedChanges(def, gated, existing, patch)
}

// ---------------------------------------------------------------------------
// Recycle bin entries
// ---------------------------------------------------------------------------

export type RecycleEntry = {
  id: number
  tenantId: number
  entityType: string
  entityTable: string
  entityPk: string
  entityLabel: string | null
  module: string | null
  reason: string | null
  status: RecycleEntryStatus
  legalHold: boolean
  snapshotHash: string | null
  deletedBy: number | null
  deletedByName: string | null
  deletedAt: string
  restoreDeadline: string | null
  restoredBy: number | null
  restoredAt: string | null
  purgedAt: string | null
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value ?? "")
}
const isoOrNull = (v: unknown) => (v == null ? null : toIso(v))

function mapEntry(r: Row): RecycleEntry {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    entityType: String(r.entity_type),
    entityTable: String(r.entity_table),
    entityPk: String(r.entity_pk),
    entityLabel: (r.entity_label as string) ?? null,
    module: (r.module as string) ?? null,
    reason: (r.reason as string) ?? null,
    status: String(r.status) as RecycleEntryStatus,
    legalHold: Boolean(Number(r.legal_hold ?? 0)),
    snapshotHash: (r.snapshot_hash as string) ?? null,
    deletedBy: r.deleted_by == null ? null : Number(r.deleted_by),
    deletedByName: (r.deleted_by_name as string) ?? null,
    deletedAt: toIso(r.deleted_at),
    restoreDeadline: isoOrNull(r.restore_deadline),
    restoredBy: r.restored_by == null ? null : Number(r.restored_by),
    restoredAt: isoOrNull(r.restored_at),
    purgedAt: isoOrNull(r.purged_at),
  }
}

function safeParse(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function jsonSafe(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v
  return out
}

function normalizeIdemKey(key: unknown): string | null {
  const k = String(key ?? "").trim()
  if (!k) return null
  return k.slice(0, 128)
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

export type SoftDeleteResult = { ok: true; entry: RecycleEntry; replayed: boolean } | Failure

/**
 * Soft-delete a registered critical record. The row stays in place with
 * deleted_at/deleted_by/delete_reason set; an immutable snapshot + hash goes to
 * the recycle bin with the tenant's restore deadline. Idempotent by key.
 */
export async function softDeleteRecord(
  tenantId: number,
  input: { entityType: unknown; entityPk: unknown; reason: unknown; idempotencyKey?: unknown },
  actor: Actor,
  audit?: AuditContext,
): Promise<SoftDeleteResult> {
  const def = getCriticalEntity(input.entityType)
  if (!def) return fail("UNKNOWN_ENTITY", "This record type does not support soft delete", 400)
  const pk = parseEntityPk(input.entityPk)
  if (pk == null) return fail("INVALID", "A valid record id is required", 400)
  const reason = normalizeDeleteReason(input.reason)
  if (!reason || reason.length < MIN_REASON_LENGTH) {
    return fail("REASON_REQUIRED", `A delete reason of at least ${MIN_REASON_LENGTH} characters is required`, 400)
  }
  const idem = normalizeIdemKey(input.idempotencyKey)

  await ensureRecycleBinSchema()

  if (idem) {
    const replay = await replaySoftDelete(tenantId, idem, def, pk)
    if (replay) return replay
  }

  const live = (await query(`SELECT * FROM \`${def.table}\` WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    pk,
    tenantId,
  ])) as Row[]
  if (!live.length) return fail("NOT_FOUND", `${def.label} not found`, 404)
  if (live[0].deleted_at != null) return fail("ALREADY_DELETED", `${def.label} is already in the recycle bin`, 409)

  const held = await isRecordUnderLegalHold(tenantId, {
    entityType: def.entityType,
    entityPk: String(pk),
    module: def.module,
    fields: live[0],
  })
  if (held) {
    await recordAuditLog(
      {
        action: "recycle_bin.soft_delete",
        result: "denied",
        entityType: def.entityType,
        entityId: String(pk),
        metadata: { denyCode: "LEGAL_HOLD" },
      },
      audit,
    ).catch(() => {})
    return fail("LEGAL_HOLD", "This record is under a legal hold and cannot be deleted", 423)
  }

  const windowDays = await getRestoreWindowDays(tenantId)
  const deletedAt = new Date()
  const deadline = computeRestoreDeadline(deletedAt, windowDays)

  let entryId: number
  let snapshotHash: string
  let label: string
  try {
    ;({ entryId, snapshotHash, label } = await withTransaction(async (conn: Conn) => {
      const locked = await connRows(conn, `SELECT * FROM \`${def.table}\` WHERE id = ? AND tenant_id = ? FOR UPDATE`, [
        pk,
        tenantId,
      ])
      if (!locked.length) throw new StoreConflict("NOT_FOUND", `${def.label} not found`, 404)
      if (locked[0].deleted_at != null) {
        throw new StoreConflict("ALREADY_DELETED", `${def.label} is already in the recycle bin`, 409)
      }
      const snapshot = JSON.stringify(jsonSafe(locked[0]))
      const hash = createHash("sha256").update(snapshot).digest("hex")
      const lbl = entityLabel(def, locked[0])

      await connExec(
        conn,
        `UPDATE \`${def.table}\` SET deleted_at = ?, deleted_by = ?, delete_reason = ?${
          def.hasRowVersion ? ", row_version = row_version + 1" : ""
        } WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
        [deletedAt, actor.userId, reason, pk, tenantId],
      )
      const ins = await connExec(
        conn,
        `INSERT INTO recycle_bin_entries
           (tenant_id, entity_type, entity_table, entity_pk, entity_label, module, snapshot, snapshot_hash, reason,
            status, legal_hold, deleted_by, deleted_by_name, deleted_at, restore_deadline, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recycled', 0, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          def.entityType,
          def.table,
          String(pk),
          lbl,
          def.module,
          snapshot,
          hash,
          reason,
          actor.userId,
          actor.name ?? null,
          deletedAt,
          deadline,
          idem,
        ],
      )
      return { entryId: ins.insertId, snapshotHash: hash, label: lbl }
    }))
  } catch (err) {
    if (err instanceof StoreConflict) return fail(err.code, err.message, err.status)
    // A concurrent retry with the same idempotency key won the race.
    if (errno(err) === 1062 && idem) {
      const replay = await replaySoftDelete(tenantId, idem, def, pk)
      if (replay) return replay
    }
    throw err
  }

  await recordAuditLog(
    {
      action: "recycle_bin.soft_delete",
      entityType: def.entityType,
      entityId: String(pk),
      entityLabel: label,
      metadata: { recycleEntryId: entryId, reason, snapshotHash, restoreDeadline: deadline.toISOString(), windowDays },
    },
    audit,
  )
  const entry = await getRecycleEntry(tenantId, entryId)
  return { ok: true, entry: entry!, replayed: false }
}

async function replaySoftDelete(
  tenantId: number,
  idem: string,
  def: CriticalEntityDef,
  pk: number,
): Promise<SoftDeleteResult | null> {
  const rows = (await query(`SELECT * FROM recycle_bin_entries WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`, [
    tenantId,
    idem,
  ])) as Row[]
  if (!rows.length) return null
  const entry = mapEntry(rows[0])
  if (entry.entityType !== def.entityType || entry.entityPk !== String(pk)) {
    return fail("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used for a different record", 422)
  }
  return { ok: true, entry, replayed: true }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export type ListRecycleQuery = {
  status?: RecycleEntryStatus
  entityType?: string
  q?: string
  limit?: number
  offset?: number
}

export async function listRecycleEntries(tenantId: number, q: ListRecycleQuery = {}): Promise<RecycleEntry[]> {
  await ensureRecycleBinSchema()
  const where: string[] = ["tenant_id = ?"]
  const params: unknown[] = [tenantId]
  if (q.status) {
    where.push("status = ?")
    params.push(q.status)
  }
  if (q.entityType) {
    where.push("entity_type = ?")
    params.push(String(q.entityType).slice(0, 120))
  }
  if (q.q) {
    where.push("(entity_label LIKE ? OR entity_pk LIKE ? OR reason LIKE ?)")
    const like = `%${String(q.q).slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    params.push(like, like, like)
  }
  const limit = Math.min(200, Math.max(1, Math.floor(q.limit ?? 100)))
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  const rows = (await query(
    `SELECT * FROM recycle_bin_entries WHERE ${where.join(" AND ")} ORDER BY deleted_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )) as Row[]
  return rows.map(mapEntry)
}

export async function getRecycleEntry(tenantId: number, id: number): Promise<RecycleEntry | null> {
  await ensureRecycleBinSchema()
  const rows = (await query(`SELECT * FROM recycle_bin_entries WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    tenantId,
  ])) as Row[]
  return rows.length ? mapEntry(rows[0]) : null
}

/**
 * Tenant-scoped lookup that ALSO records a denied audit event when the id
 * exists under another tenant — the caller still gets a plain 404 so nothing
 * about the foreign entry leaks.
 */
async function loadEntryForAction(
  tenantId: number,
  id: number,
  action: string,
  audit?: AuditContext,
): Promise<RecycleEntry | Failure> {
  const entry = await getRecycleEntry(tenantId, id)
  if (entry) return entry
  const foreign = (await query(`SELECT tenant_id FROM recycle_bin_entries WHERE id = ? LIMIT 1`, [id])) as Row[]
  if (foreign.length) {
    await recordAuditLog(
      { action, result: "denied", entityType: "recycle_bin_entry", entityId: String(id), metadata: { denyCode: "WRONG_TENANT" } },
      audit,
    ).catch(() => {})
  }
  return fail("NOT_FOUND", "Recycle bin entry not found", 404)
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RestoreResult = { ok: true; entry: RecycleEntry; replayed: boolean } | Failure

/**
 * Restore a soft-deleted record in place: clear deleted_at/by/reason on the
 * SAME row (same PK, untouched foreign keys), mark the ledger entry restored,
 * and write an immutable audit event. Wrong tenant, legal hold, expired window,
 * wrong state and concurrent double-restores are all rejected before/inside the
 * transaction.
 */
export async function restoreEntry(
  tenantId: number,
  id: number,
  actor: Actor,
  opts: { overrideWindow?: boolean; idempotencyKey?: unknown } = {},
  audit?: AuditContext,
): Promise<RestoreResult> {
  await ensureRecycleBinSchema()
  const loaded = await loadEntryForAction(tenantId, id, "recycle_bin.restore", audit)
  if ("ok" in loaded) return loaded
  const entry = loaded
  const idem = normalizeIdemKey(opts.idempotencyKey)

  if (entry.status === "restored" && idem) {
    const rows = (await query(`SELECT restore_key FROM recycle_bin_entries WHERE id = ? AND tenant_id = ?`, [
      id,
      tenantId,
    ])) as Row[]
    if (rows[0]?.restore_key === idem) return { ok: true, entry, replayed: true }
  }

  const def = getCriticalEntity(entry.entityType)
  if (!def || def.table !== entry.entityTable) {
    return fail("UNKNOWN_ENTITY", "This record type can no longer be restored", 409)
  }

  const legalHoldActive = await isRecordUnderLegalHold(tenantId, {
    entityType: entry.entityType,
    entityPk: entry.entityPk,
    module: entry.module,
  })
  const decision = evaluateRestore(
    { tenantId: entry.tenantId, status: entry.status, restoreDeadline: entry.restoreDeadline, legalHold: entry.legalHold },
    { tenantId, legalHoldActive, overrideWindow: opts.overrideWindow },
  )
  if (!decision.ok) {
    await recordAuditLog(
      {
        action: "recycle_bin.restore",
        result: "denied",
        entityType: entry.entityType,
        entityId: entry.entityPk,
        metadata: { recycleEntryId: id, denyCode: decision.code },
      },
      audit,
    ).catch(() => {})
    return fail(decision.code, decision.message, decision.status)
  }

  try {
    await withTransaction(async (conn: Conn) => {
      const lock = await connRows(conn, `SELECT status FROM recycle_bin_entries WHERE id = ? AND tenant_id = ? FOR UPDATE`, [
        id,
        tenantId,
      ])
      if (!lock.length || lock[0].status !== "recycled") {
        throw new StoreConflict("NOT_RECYCLED", "This entry was already restored or purged", 409)
      }
      const rec = await connRows(conn, `SELECT id, deleted_at FROM \`${def.table}\` WHERE id = ? AND tenant_id = ? FOR UPDATE`, [
        entry.entityPk,
        tenantId,
      ])
      if (!rec.length) throw new StoreConflict("RECORD_MISSING", "The underlying record no longer exists", 409)
      if (rec[0].deleted_at == null) throw new StoreConflict("ALREADY_LIVE", "The record is already active", 409)

      await connExec(
        conn,
        `UPDATE \`${def.table}\` SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL${
          def.hasRowVersion ? ", row_version = row_version + 1" : ""
        } WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL`,
        [entry.entityPk, tenantId],
      )
      await connExec(
        conn,
        `UPDATE recycle_bin_entries SET status = 'restored', restored_by = ?, restored_at = NOW(), restore_key = ?
          WHERE id = ? AND tenant_id = ? AND status = 'recycled'`,
        [actor.userId, idem, id, tenantId],
      )
    })
  } catch (err) {
    if (err instanceof StoreConflict) {
      await recordAuditLog(
        {
          action: "recycle_bin.restore",
          result: "failure",
          entityType: entry.entityType,
          entityId: entry.entityPk,
          metadata: { recycleEntryId: id, denyCode: err.code },
        },
        audit,
      ).catch(() => {})
      return fail(err.code, err.message, err.status)
    }
    if (errno(err) === 1062) return fail("UNIQUE_CONFLICT", "An active record now uses the same unique value", 409)
    throw err
  }

  await recordAuditLog(
    {
      action: "recycle_bin.restore",
      entityType: entry.entityType,
      entityId: entry.entityPk,
      entityLabel: entry.entityLabel,
      metadata: {
        recycleEntryId: id,
        snapshotHash: entry.snapshotHash,
        overrideWindow: Boolean(opts.overrideWindow),
        referencesPreserved: true,
      },
    },
    audit,
  )
  const updated = await getRecycleEntry(tenantId, id)
  return { ok: true, entry: updated!, replayed: false }
}

// ---------------------------------------------------------------------------
// Purge (hard delete)
// ---------------------------------------------------------------------------

export type PurgeResult = { ok: true; entry: RecycleEntry } | Failure

/** Live references that would be orphaned by a physical delete. */
async function countBlockingReferences(def: CriticalEntityDef, snapshot: Record<string, unknown>): Promise<number> {
  if (def.entityType === "client") {
    const links = await getClientLinkCounts({
      finance_party_id: (snapshot.finance_party_id as string) ?? null,
      company_id: snapshot.company_id == null ? null : Number(snapshot.company_id),
    })
    return links.total
  }
  return 0
}

export async function purgeEntry(
  tenantId: number,
  id: number,
  actor: Actor,
  mode: "manual" | "expiry" = "manual",
  audit?: AuditContext,
  now: Date = new Date(),
): Promise<PurgeResult> {
  await ensureRecycleBinSchema()
  const loaded = await loadEntryForAction(tenantId, id, "recycle_bin.purge", audit)
  if ("ok" in loaded) return loaded
  const entry = loaded
  const def = getCriticalEntity(entry.entityType)
  if (!def || def.table !== entry.entityTable) return fail("UNKNOWN_ENTITY", "Unknown record type", 409)

  const legalHoldActive = await isRecordUnderLegalHold(tenantId, {
    entityType: entry.entityType,
    entityPk: entry.entityPk,
    module: entry.module,
  })
  const decision = evaluatePurge(
    { tenantId: entry.tenantId, status: entry.status, restoreDeadline: entry.restoreDeadline, legalHold: entry.legalHold },
    { tenantId, legalHoldActive, mode, now },
  )
  if (!decision.ok) {
    await recordAuditLog(
      {
        action: mode === "expiry" ? "recycle_bin.purge_expired" : "recycle_bin.purge",
        result: "denied",
        entityType: entry.entityType,
        entityId: entry.entityPk,
        metadata: { recycleEntryId: id, denyCode: decision.code },
      },
      audit,
    ).catch(() => {})
    return fail(decision.code, decision.message, decision.status)
  }

  const snapshotRows = (await query(`SELECT snapshot FROM recycle_bin_entries WHERE id = ? AND tenant_id = ?`, [
    id,
    tenantId,
  ])) as Row[]
  const refs = await countBlockingReferences(def, safeParse(snapshotRows[0]?.snapshot) ?? {})
  if (refs > 0) {
    await recordAuditLog(
      {
        action: mode === "expiry" ? "recycle_bin.purge_expired" : "recycle_bin.purge",
        result: "denied",
        entityType: entry.entityType,
        entityId: entry.entityPk,
        metadata: { recycleEntryId: id, denyCode: "REFERENCED", references: refs },
      },
      audit,
    ).catch(() => {})
    return fail("REFERENCED", `Cannot permanently delete: ${refs} linked record(s) still reference it`, 409)
  }

  try {
    await withTransaction(async (conn: Conn) => {
      const lock = await connRows(conn, `SELECT status FROM recycle_bin_entries WHERE id = ? AND tenant_id = ? FOR UPDATE`, [
        id,
        tenantId,
      ])
      if (!lock.length || lock[0].status !== "recycled") {
        throw new StoreConflict("NOT_RECYCLED", "This entry was already restored or purged", 409)
      }
      await connExec(conn, `DELETE FROM \`${def.table}\` WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL`, [
        entry.entityPk,
        tenantId,
      ])
      // The snapshot body is dropped; the ledger row + snapshot hash remain as an
      // immutable tombstone of what existed and who purged it.
      await connExec(
        conn,
        `UPDATE recycle_bin_entries SET status = 'purged', purged_by = ?, purged_at = NOW(), snapshot = '{}'
          WHERE id = ? AND tenant_id = ? AND status = 'recycled'`,
        [actor.userId, id, tenantId],
      )
    })
  } catch (err) {
    if (err instanceof StoreConflict) return fail(err.code, err.message, err.status)
    if (errno(err) === 1451) return fail("REFERENCED", "Cannot permanently delete: other records reference it", 409)
    throw err
  }

  await recordAuditLog(
    {
      action: mode === "expiry" ? "recycle_bin.purge_expired" : "recycle_bin.purge",
      entityType: entry.entityType,
      entityId: entry.entityPk,
      entityLabel: entry.entityLabel,
      metadata: { recycleEntryId: id, mode, snapshotHash: entry.snapshotHash },
    },
    audit,
  )
  const updated = await getRecycleEntry(tenantId, id)
  return { ok: true, entry: updated! }
}

export type PurgeSweepResult = { examined: number; purged: number; skipped: Array<{ id: number; code: string }> }

/**
 * Hard-delete every entry whose restore window has closed. Legal-hold and
 * still-referenced records are skipped (and stay recoverable) — never forced.
 */
export async function purgeExpired(tenantId: number, actor: Actor, now: Date = new Date()): Promise<PurgeSweepResult> {
  await ensureRecycleBinSchema()
  const rows = (await query(
    `SELECT id FROM recycle_bin_entries
      WHERE tenant_id = ? AND status = 'recycled' AND restore_deadline IS NOT NULL AND restore_deadline <= ?
      ORDER BY id LIMIT 500`,
    [tenantId, now],
  )) as Row[]
  const result: PurgeSweepResult = { examined: rows.length, purged: 0, skipped: [] }
  for (const r of rows) {
    const res = await purgeEntry(tenantId, Number(r.id), actor, "expiry", undefined, now)
    if (res.ok) result.purged++
    else result.skipped.push({ id: Number(r.id), code: res.code })
  }
  return result
}

// ---------------------------------------------------------------------------
// Version history + approval
// ---------------------------------------------------------------------------

export type RecordVersion = {
  id: number
  tenantId: number
  entityType: string
  entityPk: string
  versionNo: number
  baseVersionNo: number
  baseRowVersion: number | null
  status: RecordVersionStatus
  payload: Record<string, unknown>
  baseValues: Record<string, unknown>
  beforeValues: Record<string, unknown> | null
  summary: string | null
  revertOfVersionId: number | null
  approvalMode: "engine" | "peer" | null
  approvalRequestId: number | null
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  submittedAt: string | null
  decidedBy: number | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  publishedBy: number | null
  publishedAt: string | null
}

function mapVersion(r: Row): RecordVersion {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    entityType: String(r.entity_type),
    entityPk: String(r.entity_pk),
    versionNo: Number(r.version_no),
    baseVersionNo: Number(r.base_version_no ?? 0),
    baseRowVersion: r.base_row_version == null ? null : Number(r.base_row_version),
    status: String(r.status) as RecordVersionStatus,
    payload: safeParse(r.payload) ?? {},
    baseValues: safeParse(r.base_values) ?? {},
    beforeValues: r.before_values == null ? null : safeParse(r.before_values),
    summary: (r.summary as string) ?? null,
    revertOfVersionId: r.revert_of_version_id == null ? null : Number(r.revert_of_version_id),
    approvalMode: (r.approval_mode as "engine" | "peer") ?? null,
    approvalRequestId: r.approval_request_id == null ? null : Number(r.approval_request_id),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdByName: (r.created_by_name as string) ?? null,
    createdAt: toIso(r.created_at),
    submittedAt: isoOrNull(r.submitted_at),
    decidedBy: r.decided_by == null ? null : Number(r.decided_by),
    decidedByName: (r.decided_by_name as string) ?? null,
    decidedAt: isoOrNull(r.decided_at),
    decisionNote: (r.decision_note as string) ?? null,
    publishedBy: r.published_by == null ? null : Number(r.published_by),
    publishedAt: isoOrNull(r.published_at),
  }
}

async function currentPublishedVersionNo(tenantId: number, entityType: string, entityPk: string): Promise<number> {
  const rows = (await query(
    `SELECT MAX(version_no) AS v FROM record_versions
      WHERE tenant_id = ? AND entity_type = ? AND entity_pk = ? AND status = 'published'`,
    [tenantId, entityType, entityPk],
  )) as Array<{ v: number | null }>
  return rows.length && rows[0].v != null ? Number(rows[0].v) : 0
}

async function maxVersionNo(tenantId: number, entityType: string, entityPk: string): Promise<number> {
  const rows = (await query(
    `SELECT MAX(version_no) AS v FROM record_versions WHERE tenant_id = ? AND entity_type = ? AND entity_pk = ?`,
    [tenantId, entityType, entityPk],
  )) as Array<{ v: number | null }>
  return rows.length && rows[0].v != null ? Number(rows[0].v) : 0
}

export async function getVersion(tenantId: number, id: number): Promise<RecordVersion | null> {
  await ensureRecycleBinSchema()
  const rows = (await query(`SELECT * FROM record_versions WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    tenantId,
  ])) as Row[]
  return rows.length ? mapVersion(rows[0]) : null
}

export async function listVersions(
  tenantId: number,
  filter: { entityType?: string; entityPk?: string; status?: RecordVersionStatus; limit?: number } = {},
): Promise<RecordVersion[]> {
  await ensureRecycleBinSchema()
  const where: string[] = ["tenant_id = ?"]
  const params: unknown[] = [tenantId]
  if (filter.entityType) {
    where.push("entity_type = ?")
    params.push(filter.entityType)
  }
  if (filter.entityPk) {
    where.push("entity_pk = ?")
    params.push(filter.entityPk)
  }
  if (filter.status) {
    where.push("status = ?")
    params.push(filter.status)
  }
  const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 100)))
  const rows = (await query(
    `SELECT * FROM record_versions WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit],
  )) as Row[]
  return rows.map(mapVersion)
}

export type VersionResult = { ok: true; version: RecordVersion; replayed?: boolean } | Failure

function canonicalPayload(p: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]))
}

/**
 * Draft a versioned sensitive edit. Nothing is applied to the live record —
 * the proposed values wait for approval + publish. The author's view of the
 * affected fields (`base_values`) is captured so staleness is detected exactly.
 */
export async function createVersion(
  tenantId: number,
  raw: {
    entityType?: unknown
    entityPk?: unknown
    payload?: unknown
    summary?: unknown
    expectedRowVersion?: unknown
    revertOfVersionId?: unknown
  },
  actor: Actor,
  idempotencyKey?: unknown,
  audit?: AuditContext,
): Promise<VersionResult> {
  const def = getCriticalEntity(raw.entityType)
  if (!def) return fail("UNKNOWN_ENTITY", "This record type does not support versioned edits", 400)
  const pk = parseEntityPk(raw.entityPk)
  if (pk == null) return fail("INVALID", "A valid record id is required", 400)
  await ensureRecycleBinSchema()

  let proposed: Record<string, unknown>
  let revertOf: number | null = null
  if (raw.revertOfVersionId != null && raw.revertOfVersionId !== "") {
    revertOf = parseEntityPk(raw.revertOfVersionId)
    if (revertOf == null) return fail("INVALID", "Invalid revertOfVersionId", 400)
    const target = await getVersion(tenantId, revertOf)
    if (!target || target.entityType !== def.entityType || target.entityPk !== String(pk)) {
      return fail("NOT_FOUND", "Version to revert not found", 404)
    }
    if (target.status !== "published" || !target.beforeValues) {
      return fail("NOT_REVERTIBLE", "Only a published version can be reverted", 409)
    }
    proposed = target.beforeValues
  } else {
    if (raw.payload == null || typeof raw.payload !== "object" || Array.isArray(raw.payload)) {
      return fail("INVALID", "A payload object of proposed changes is required", 400)
    }
    proposed = raw.payload as Record<string, unknown>
  }
  if (JSON.stringify(proposed).length > RECORD_VERSION_LIMITS.PAYLOAD_BYTES) {
    return fail("INVALID", "The proposed changes are too large", 400)
  }

  const payload: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(proposed)) {
    const fdef = def.versionedFields[field]
    if (!fdef) return fail("FIELD_NOT_VERSIONABLE", `Field "${field.slice(0, 64)}" cannot be edited here`, 400)
    const v = validateFieldValue(fdef, value)
    if (!v.ok) return fail("INVALID", v.message, 400)
    payload[field] = v.value
  }
  if (!Object.keys(payload).length) return fail("INVALID", "The payload must contain at least one changed field", 400)

  const summary = String(raw.summary ?? "").trim().slice(0, RECORD_VERSION_LIMITS.SUMMARY) || null
  const idem = normalizeIdemKey(idempotencyKey)
  if (idem) {
    const replay = await replayVersion(tenantId, idem, def, pk, payload)
    if (replay) return replay
  }

  const live = (await query(`SELECT * FROM \`${def.table}\` WHERE id = ? AND tenant_id = ? LIMIT 1`, [pk, tenantId])) as Row[]
  if (!live.length) return fail("NOT_FOUND", `${def.label} not found`, 404)
  if (live[0].deleted_at != null) return fail("DELETED", `${def.label} is in the recycle bin; restore it first`, 409)

  const currentRowVersion = def.hasRowVersion && live[0].row_version != null ? Number(live[0].row_version) : null
  if (raw.expectedRowVersion != null && raw.expectedRowVersion !== "" && currentRowVersion != null) {
    if (Number(raw.expectedRowVersion) !== currentRowVersion) {
      return fail("STALE", "The record changed since you opened it; reload and try again", 409)
    }
  }

  const baseValues: Record<string, unknown> = {}
  for (const field of Object.keys(payload)) baseValues[field] = live[0][field] ?? null
  const changed = Object.keys(payload).filter((f) => !valuesEqual(def.versionedFields[f], baseValues[f], payload[f]))
  if (!changed.length) return fail("NO_CHANGES", "The proposed values match the current record", 400)
  const finalPayload = Object.fromEntries(changed.map((f) => [f, payload[f]]))
  const finalBase = Object.fromEntries(changed.map((f) => [f, jsonSafe({ v: baseValues[f] }).v]))

  const baseVersionNo = await currentPublishedVersionNo(tenantId, def.entityType, String(pk))

  let insertId = 0
  let versionNo = 0
  for (let attempt = 0; attempt < 3 && !insertId; attempt++) {
    versionNo = nextVersionNo(await maxVersionNo(tenantId, def.entityType, String(pk)))
    try {
      const res = (await query(
        `INSERT INTO record_versions
           (tenant_id, entity_type, entity_pk, version_no, base_version_no, base_row_version, status, payload, base_values,
            summary, revert_of_version_id, created_by, created_by_name, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          def.entityType,
          String(pk),
          versionNo,
          baseVersionNo,
          currentRowVersion,
          JSON.stringify(finalPayload),
          JSON.stringify(finalBase),
          summary,
          revertOf,
          actor.userId,
          actor.name ?? null,
          idem,
        ],
      )) as { insertId: number }
      insertId = Number(res.insertId)
    } catch (err) {
      if (errno(err) !== 1062) throw err
      if (idem) {
        const replay = await replayVersion(tenantId, idem, def, pk, payload)
        if (replay) return replay
      }
      // version_no collision with a concurrent author: take the next number.
    }
  }
  if (!insertId) return fail("CONFLICT", "Could not allocate a version number; retry", 409)

  await recordAuditLog(
    {
      action: "record_version.create",
      entityType: def.entityType,
      entityId: String(pk),
      before: finalBase,
      after: finalPayload,
      metadata: { versionId: insertId, versionNo, baseVersionNo, revertOfVersionId: revertOf },
    },
    audit,
  )
  return { ok: true, version: (await getVersion(tenantId, insertId))! }
}

async function replayVersion(
  tenantId: number,
  idem: string,
  def: CriticalEntityDef,
  pk: number,
  payload: Record<string, unknown>,
): Promise<VersionResult | null> {
  const rows = (await query(`SELECT * FROM record_versions WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`, [
    tenantId,
    idem,
  ])) as Row[]
  if (!rows.length) return null
  const v = mapVersion(rows[0])
  if (v.entityType !== def.entityType || v.entityPk !== String(pk)) {
    return fail("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used for a different request", 422)
  }
  // Payload may have been trimmed to changed fields — replay must be a subset match.
  const mismatch = Object.keys(v.payload).some((k) => !valuesEqual(def.versionedFields[k], v.payload[k], payload[k]))
  if (mismatch) return fail("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used with different changes", 422)
  return { ok: true, version: v, replayed: true }
}

/**
 * Submit a draft for approval. Routed through the Approval Authority engine
 * under module key `records.<entityType>`; when no rule is configured the
 * change falls back to peer approval by a different tenant admin.
 */
export async function submitVersion(
  tenantId: number,
  id: number,
  actor: Actor,
  audit?: AuditContext,
): Promise<VersionResult> {
  const version = await getVersion(tenantId, id)
  if (!version) return fail("NOT_FOUND", "Version not found", 404)
  const def = getCriticalEntity(version.entityType)
  if (!def) return fail("UNKNOWN_ENTITY", "Unknown record type", 409)
  if (version.createdBy !== actor.userId && actor.role !== "admin") {
    return fail("FORBIDDEN", "Only the author can submit this change", 403)
  }
  const gate = evaluateTransition("submit", {
    status: version.status,
    baseVersionNo: version.baseVersionNo,
    currentPublishedVersionNo: 0,
    createdBy: version.createdBy ?? 0,
    actorUserId: actor.userId,
  })
  if (!gate.ok) return fail(gate.code, gate.message, gate.status)

  const amount = typeof version.payload.credit_limit === "number" ? (version.payload.credit_limit as number) : null
  const raise = await raiseApprovalRequest({
    moduleKey: `records.${def.entityType}`,
    entityType: "record_version",
    entityPk: version.id,
    entityRef: `${def.label} #${version.entityPk} v${version.versionNo}`,
    title: `${def.label} change: ${Object.keys(version.payload).map((f) => def.versionedFields[f]?.label ?? f).join(", ")}`,
    amount,
    requesterRole: actor.role ?? null,
    requestedBy: actor.userId,
    requestedByName: actor.name ?? null,
  })
  const mode: "engine" | "peer" = raise.autoApproved ? "peer" : "engine"

  const res = (await query(
    `UPDATE record_versions SET status = 'pending', submitted_at = NOW(), approval_mode = ?, approval_request_id = ?
      WHERE id = ? AND tenant_id = ? AND status = 'draft'`,
    [mode, raise.autoApproved ? null : raise.requestId, id, tenantId],
  )) as { affectedRows?: number }
  if (!Number(res?.affectedRows ?? 0)) return fail("WRONG_STATUS", "This version was already submitted", 409)

  await recordAuditLog(
    {
      action: "record_version.submit",
      entityType: version.entityType,
      entityId: version.entityPk,
      metadata: { versionId: id, versionNo: version.versionNo, approvalMode: mode, approvalRequestId: raise.requestId },
    },
    audit,
  )
  return { ok: true, version: (await getVersion(tenantId, id))! }
}

/**
 * Approve or reject a pending version. Engine-mode versions are decided by the
 * Approval Authority chain (assignees, levels, delegation); peer-mode versions
 * need a tenant admin who is NOT the author. Self-approval is always refused.
 */
export async function decideVersion(
  tenantId: number,
  id: number,
  action: "approve" | "reject",
  actor: Actor,
  opts: { note?: unknown; isTenantAdmin?: boolean } = {},
  audit?: AuditContext,
): Promise<VersionResult & { engineStatus?: string }> {
  const version = await getVersion(tenantId, id)
  if (!version) return fail("NOT_FOUND", "Version not found", 404)
  if (version.status !== "pending") return fail("WRONG_STATUS", `Cannot ${action} a version that is ${version.status}`, 409)
  if (action === "approve" && version.createdBy === actor.userId) {
    return fail("SELF_APPROVAL", "You cannot approve your own change; another approver is required", 403)
  }
  const note = normalizeDecisionNote(opts.note)
  let next: "approved" | "rejected" | "pending" = action === "approve" ? "approved" : "rejected"
  let engineStatus: string | undefined

  if (version.approvalMode === "engine" && version.approvalRequestId) {
    const acted = await actOnApprovalRequest(
      { requestId: version.approvalRequestId, actorId: actor.userId, actorName: actor.name ?? null, action, comment: note },
      { isAdmin: actor.role === "admin" },
    )
    if (!acted.ok) return fail("APPROVAL_DENIED", acted.error, acted.code)
    engineStatus = acted.status
    next = acted.status === "approved" ? "approved" : acted.status === "rejected" ? "rejected" : "pending"
  } else {
    if (!opts.isTenantAdmin) return fail("FORBIDDEN", "A tenant admin must decide this change", 403)
  }

  if (next !== "pending") {
    const res = (await query(
      `UPDATE record_versions SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = NOW(), decision_note = ?
        WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
      [next, actor.userId, actor.name ?? null, note, id, tenantId],
    )) as { affectedRows?: number }
    if (!Number(res?.affectedRows ?? 0)) return fail("WRONG_STATUS", "This version was already decided", 409)
  }

  await recordAuditLog(
    {
      action: `record_version.${action}`,
      entityType: version.entityType,
      entityId: version.entityPk,
      metadata: { versionId: id, versionNo: version.versionNo, note, resultingStatus: next, engineStatus },
    },
    audit,
  )
  return { ok: true, version: (await getVersion(tenantId, id))!, engineStatus }
}

/**
 * Publish an approved version onto the live record. Inside one transaction the
 * version and the live row are locked, the row's CURRENT values for the edited
 * fields are compared to what the author saw (`base_values`): any drift — a
 * concurrent publish, a restore, an out-of-band edit — marks the version
 * superseded and returns STALE instead of clobbering the newer state.
 */
export async function publishVersion(
  tenantId: number,
  id: number,
  actor: Actor,
  audit?: AuditContext,
): Promise<VersionResult & { applied?: Record<string, unknown> }> {
  const version = await getVersion(tenantId, id)
  if (!version) return fail("NOT_FOUND", "Version not found", 404)
  const def = getCriticalEntity(version.entityType)
  if (!def) return fail("UNKNOWN_ENTITY", "Unknown record type", 409)
  if (version.createdBy !== actor.userId && actor.role !== "admin") {
    return fail("FORBIDDEN", "Only the author or an admin can publish this change", 403)
  }

  let before: Record<string, unknown> = {}
  let staleDetected = false
  try {
    await withTransaction(async (conn: Conn) => {
      const vrows = await connRows(conn, `SELECT status FROM record_versions WHERE id = ? AND tenant_id = ? FOR UPDATE`, [
        id,
        tenantId,
      ])
      const status = String(vrows[0]?.status ?? "") as RecordVersionStatus
      const live = await connRows(conn, `SELECT * FROM \`${def.table}\` WHERE id = ? AND tenant_id = ? FOR UPDATE`, [
        version.entityPk,
        tenantId,
      ])
      if (!live.length) throw new StoreConflict("NOT_FOUND", `${def.label} not found`, 404)
      if (live[0].deleted_at != null) throw new StoreConflict("DELETED", `${def.label} is in the recycle bin`, 409)

      const liveStale = isLiveRowStale({
        baseRowVersion: null,
        currentRowVersion: null,
        baseValues: version.baseValues,
        currentValues: live[0],
        equals: (f, a, b) => valuesEqual(def.versionedFields[f], a, b),
      })
      const gate = evaluateTransition("publish", {
        status,
        baseVersionNo: version.baseVersionNo,
        currentPublishedVersionNo: 0,
        createdBy: version.createdBy ?? 0,
        actorUserId: actor.userId,
        liveStale,
      })
      if (!gate.ok) {
        if (gate.code === "STALE") {
          await connExec(
            conn,
            `UPDATE record_versions SET status = 'superseded' WHERE id = ? AND tenant_id = ? AND status = 'approved'`,
            [id, tenantId],
          )
          staleDetected = true
          return
        }
        throw new StoreConflict(gate.code, gate.message, gate.status)
      }

      const cols = Object.keys(version.payload).filter((c) => def.versionedFields[c])
      before = Object.fromEntries(cols.map((c) => [c, jsonSafe({ v: live[0][c] }).v ?? null]))
      const sets = cols.map((c) => `\`${c}\` = ?`).join(", ")
      await connExec(
        conn,
        `UPDATE \`${def.table}\` SET ${sets}${def.hasRowVersion ? ", row_version = row_version + 1" : ""}
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
        [...cols.map((c) => version.payload[c]), version.entityPk, tenantId],
      )
      await connExec(
        conn,
        `UPDATE record_versions SET status = 'published', published_by = ?, published_at = NOW(), before_values = ?
          WHERE id = ? AND tenant_id = ? AND status = 'approved'`,
        [actor.userId, JSON.stringify(before), id, tenantId],
      )
    })
  } catch (err) {
    if (err instanceof StoreConflict) return fail(err.code, err.message, err.status)
    throw err
  }

  if (staleDetected) {
    await recordAuditLog(
      {
        action: "record_version.publish",
        result: "failure",
        entityType: version.entityType,
        entityId: version.entityPk,
        metadata: { versionId: id, versionNo: version.versionNo, denyCode: "STALE", superseded: true },
      },
      audit,
    ).catch(() => {})
    return fail("STALE", "The record changed since this edit was proposed; it has been superseded", 409)
  }

  await recordAuditLog(
    {
      action: "record_version.publish",
      entityType: version.entityType,
      entityId: version.entityPk,
      before,
      after: version.payload,
      metadata: { versionId: id, versionNo: version.versionNo, approvalRequestId: version.approvalRequestId },
    },
    audit,
  )
  return { ok: true, version: (await getVersion(tenantId, id))!, applied: version.payload }
}

export { StoreConflict }
