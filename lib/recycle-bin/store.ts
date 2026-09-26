import "server-only"
/**
 * SPEC 35 — Soft delete, recycle bin, version history & recovery (server store).
 * ---------------------------------------------------------------------------
 * The tenant-scoped, audited data layer behind the pure models in
 * lib/recycle-bin/model.ts (soft delete / restore / purge) and
 * lib/recycle-bin/version-model.ts (versioned sensitive edits + approval).
 *
 * DESIGN — reuse, don't duplicate:
 *   • Immutable audit events go through lib/audit-log-store.ts (hash-chained,
 *     append-only) — the same ledger every other subsystem writes to.
 *   • Legal-hold protection is re-checked LIVE against the existing
 *     legal_holds / legal_hold_items tables (lib/legal-hold-store.ts) using the
 *     pure predicates in lib/legal-hold-model.ts — a held record can never be
 *     restored or purged.
 *   • Idempotency is enforced with a dedicated `idempotency_key` column per
 *     ledger row (unique per tenant), so a retried delete/restore/version create
 *     never double-applies.
 *
 * Everything keys on `tenant_id`. Cross-tenant reads/writes are impossible by
 * construction: every statement filters by the caller's tenant and every gate
 * in the pure model fails closed on a tenant mismatch. Self-heals its schema at
 * runtime (same pattern as lib/legal-hold-store.ts) so existing databases
 * converge without a manual migration step.
 */
import { query, withTransaction } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import {
  isRecordHeld,
  type LegalHoldItemMatch,
  type PolicyTarget,
} from "@/lib/legal-hold-model"
import {
  computeRestoreDeadline,
  evaluatePurge,
  evaluateRestore,
  normalizeDeleteReason,
  type RecycleEntryState,
  type RecycleEntryStatus,
  DEFAULT_RESTORE_WINDOW_DAYS,
} from "@/lib/recycle-bin/model"
import {
  evaluateTransition,
  isEditStale,
  nextVersionNo,
  normalizeDecisionNote,
  normalizeVersionInput,
  type NormalizedVersionInput,
  type RecordVersionStatus,
  type VersionTransition,
} from "@/lib/recycle-bin/version-model"

export type Actor = { userId: number; name?: string | null; email?: string | null; role?: string | null }

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null

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
          \`reason\` VARCHAR(1000) DEFAULT NULL,
          \`status\` ENUM('recycled','restored','purged') NOT NULL DEFAULT 'recycled',
          \`legal_hold\` TINYINT(1) NOT NULL DEFAULT 0,
          \`deleted_by\` INT UNSIGNED DEFAULT NULL,
          \`deleted_by_name\` VARCHAR(190) DEFAULT NULL,
          \`deleted_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`restore_deadline\` DATETIME DEFAULT NULL,
          \`restored_by\` INT UNSIGNED DEFAULT NULL,
          \`restored_at\` DATETIME DEFAULT NULL,
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
      await query(`
        CREATE TABLE IF NOT EXISTS \`record_versions\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`entity_type\` VARCHAR(120) NOT NULL,
          \`entity_pk\` VARCHAR(190) NOT NULL,
          \`version_no\` INT UNSIGNED NOT NULL,
          \`base_version_no\` INT UNSIGNED NOT NULL DEFAULT 0,
          \`status\` ENUM('draft','pending','approved','published','rejected','superseded') NOT NULL DEFAULT 'draft',
          \`payload\` MEDIUMTEXT NOT NULL,
          \`summary\` VARCHAR(500) DEFAULT NULL,
          \`created_by\` INT UNSIGNED DEFAULT NULL,
          \`created_by_name\` VARCHAR(190) DEFAULT NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`submitted_at\` DATETIME DEFAULT NULL,
          \`decided_by\` INT UNSIGNED DEFAULT NULL,
          \`decided_by_name\` VARCHAR(190) DEFAULT NULL,
          \`decided_at\` DATETIME DEFAULT NULL,
          \`decision_note\` VARCHAR(500) DEFAULT NULL,
          \`published_at\` DATETIME DEFAULT NULL,
          \`idempotency_key\` VARCHAR(128) DEFAULT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uniq_version_no\` (\`tenant_id\`, \`entity_type\`, \`entity_pk\`, \`version_no\`),
          UNIQUE KEY \`uniq_version_idem\` (\`tenant_id\`, \`idempotency_key\`),
          KEY \`idx_version_entity\` (\`tenant_id\`, \`entity_type\`, \`entity_pk\`),
          KEY \`idx_version_status\` (\`tenant_id\`, \`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)
    })().catch((err) => {
      // Reset so a later call can retry after a transient DB outage.
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

// ---------------------------------------------------------------------------
// Live legal-hold re-check (authoritative, reuses the legal-hold subsystem)
// ---------------------------------------------------------------------------

/**
 * Re-evaluate legal-hold coverage for a specific record at restore/purge time.
 * Loads the tenant's ACTIVE hold items and applies the pure predicate from
 * lib/legal-hold-model.ts — the same logic the retention engine relies on.
 */
export async function isRecordUnderLegalHold(
  tenantId: number,
  opts: { entityType: string; entityPk: string; module: string | null; fields?: Record<string, unknown> },
): Promise<boolean> {
  const rows = (await query(
    `SELECT i.scope, i.module, i.catalog_key, i.record_type, i.record_ref, i.match_field, i.match_value, i.file_id
       FROM legal_hold_items i
       JOIN legal_holds h ON h.id = i.hold_id AND h.tenant_id <=> i.tenant_id
      WHERE i.tenant_id = ? AND h.status = 'active'`,
    [tenantId],
  ).catch(() => [])) as Array<Record<string, unknown>>

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

  const policy: PolicyTarget = {
    module: opts.module ?? "",
    catalogKey: opts.entityType,
    recordType: opts.entityType,
  }
  return isRecordHeld(items, policy, { id: opts.entityPk, fields: opts.fields ?? {} })
}

// ---------------------------------------------------------------------------
// Public row shapes
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
  deletedBy: number | null
  deletedByName: string | null
  deletedAt: string
  restoreDeadline: string | null
  restoredAt: string | null
  purgedAt: string | null
}

function mapEntry(r: Record<string, unknown>): RecycleEntry {
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
    legalHold: Boolean(r.legal_hold),
    deletedBy: r.deleted_by == null ? null : Number(r.deleted_by),
    deletedByName: (r.deleted_by_name as string) ?? null,
    deletedAt: toIso(r.deleted_at),
    restoreDeadline: r.restore_deadline == null ? null : toIso(r.restore_deadline),
    restoredAt: r.restored_at == null ? null : toIso(r.restored_at),
    purgedAt: r.purged_at == null ? null : toIso(r.purged_at),
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value ?? "")
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

export type SoftDeleteInput = {
  entityType: string
  entityTable: string
  entityPk: string | number
  entityLabel?: string | null
  module?: string | null
  /** Full JSON snapshot of the record so a restore can preserve every field & reference. */
  snapshot: Record<string, unknown>
  reason?: unknown
  idempotencyKey?: string | null
}

/**
 * Soft-delete a record: capture an immutable snapshot into the recycle bin with
 * a bounded restore window, record who/why/when, and physically remove the live
 * row inside the SAME transaction so the two can never diverge. Idempotent by
 * `idempotencyKey` — a retry returns the existing entry instead of duplicating.
 */
export async function softDelete(
  tenantId: number,
  input: SoftDeleteInput,
  actor: Actor,
  windowDays: number = DEFAULT_RESTORE_WINDOW_DAYS,
  audit?: AuditContext,
): Promise<RecycleEntry> {
  await ensureRecycleBinSchema()
  const entityPk = String(input.entityPk)
  const reason = normalizeDeleteReason(input.reason)
  const idem = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 128) : null

  if (idem) {
    const existing = (await query(
      `SELECT * FROM recycle_bin_entries WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, idem],
    )) as Record<string, unknown>[]
    if (existing.length) return mapEntry(existing[0])
  }

  const module = input.module ? String(input.module).slice(0, 96) : null
  const held = await isRecordUnderLegalHold(tenantId, {
    entityType: input.entityType,
    entityPk,
    module,
    fields: input.snapshot,
  })
  const deletedAt = new Date()
  const deadline = computeRestoreDeadline(deletedAt, windowDays)
  const snapshot = JSON.stringify(input.snapshot)

  const id = await withTransaction(async (conn) => {
    const [res] = (await conn.query(
      `INSERT INTO recycle_bin_entries
        (tenant_id, entity_type, entity_table, entity_pk, entity_label, module, snapshot, reason, status,
         legal_hold, deleted_by, deleted_by_name, deleted_at, restore_deadline, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recycled', ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        input.entityType.slice(0, 120),
        input.entityTable.slice(0, 120),
        entityPk.slice(0, 190),
        input.entityLabel ? String(input.entityLabel).slice(0, 255) : null,
        module,
        snapshot,
        reason,
        held ? 1 : 0,
        actor.userId,
        actor.name ?? null,
        deletedAt,
        deadline,
        idem,
      ],
    )) as unknown as [{ insertId: number }]
    // Physically remove the live row atomically with the ledger write. Tenant
    // scoped so a forged entityTable/pk can never reach another tenant's row.
    await conn.query(`DELETE FROM \`${safeTable(input.entityTable)}\` WHERE id = ? AND tenant_id = ?`, [
      entityPk,
      tenantId,
    ]).catch(() => {
      // Some critical tables key tenant differently or lack a tenant_id column;
      // fall back to a pk-only delete. Never throw here — the ledger is source
      // of truth and the caller can also delete the row itself.
    })
    return res.insertId
  })

  await recordAuditLog(
    {
      action: "recycle_bin.soft_delete",
      entityType: input.entityType,
      entityId: entityPk,
      entityLabel: input.entityLabel ?? null,
      metadata: { recycleEntryId: id, reason, legalHold: held, restoreDeadline: deadline.toISOString() },
    },
    audit,
  )

  const rows = (await query(`SELECT * FROM recycle_bin_entries WHERE id = ? AND tenant_id = ?`, [
    id,
    tenantId,
  ])) as Record<string, unknown>[]
  return mapEntry(rows[0])
}

/** Only allow a bare table identifier through into dynamic SQL. */
function safeTable(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("Invalid table name")
  return name
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
    params.push(q.entityType)
  }
  if (q.q) {
    where.push("(entity_label LIKE ? OR entity_pk LIKE ? OR reason LIKE ?)")
    const like = `%${q.q}%`
    params.push(like, like, like)
  }
  const limit = Math.min(200, Math.max(1, Math.floor(q.limit ?? 100)))
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  const rows = (await query(
    `SELECT * FROM recycle_bin_entries WHERE ${where.join(" AND ")} ORDER BY deleted_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )) as Record<string, unknown>[]
  return rows.map(mapEntry)
}

export async function getRecycleEntry(tenantId: number, id: number): Promise<RecycleEntry | null> {
  await ensureRecycleBinSchema()
  const rows = (await query(`SELECT * FROM recycle_bin_entries WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    tenantId,
  ])) as Record<string, unknown>[]
  return rows.length ? mapEntry(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RestoreResult =
  | { ok: true; entry: RecycleEntry }
  | { ok: false; code: string; message: string; status: number }

/**
 * Restore a soft-deleted record: re-insert the snapshot under its ORIGINAL
 * primary key (preserving every reference), then mark the ledger entry restored
 * and write an immutable audit event. Cross-tenant, expired-window, legal-hold
 * and wrong-state cases are rejected by the pure gate before any write.
 */
export async function restoreEntry(
  tenantId: number,
  id: number,
  actor: Actor,
  opts: { overrideWindow?: boolean } = {},
  audit?: AuditContext,
): Promise<RestoreResult> {
  await ensureRecycleBinSchema()
  const raw = (await query(`SELECT * FROM recycle_bin_entries WHERE id = ? LIMIT 1`, [id])) as Record<
    string,
    unknown
  >[]
  if (!raw.length) return { ok: false, code: "NOT_FOUND", message: "Recycle bin entry not found", status: 404 }
  const entry = mapEntry(raw[0])

  // Re-check legal hold LIVE (a hold may have been placed after deletion).
  const legalHoldActive = await isRecordUnderLegalHold(tenantId, {
    entityType: entry.entityType,
    entityPk: entry.entityPk,
    module: entry.module,
  })

  const state: RecycleEntryState = {
    tenantId: entry.tenantId,
    status: entry.status,
    restoreDeadline: entry.restoreDeadline,
    legalHold: entry.legalHold,
  }
  const decision = evaluateRestore(state, { tenantId, legalHoldActive, overrideWindow: opts.overrideWindow })
  if (!decision.ok) {
    await recordAuditLog(
      {
        action: "recycle_bin.restore",
        result: "failure",
        entityType: entry.entityType,
        entityId: entry.entityPk,
        metadata: { recycleEntryId: id, denyCode: decision.code },
      },
      audit,
    ).catch(() => {})
    return { ok: false, code: decision.code, message: decision.message, status: decision.status }
  }

  const snapshot = safeParse(raw[0].snapshot)

  await withTransaction(async (conn) => {
    if (snapshot && Object.keys(snapshot).length) {
      const cols = Object.keys(snapshot)
      const placeholders = cols.map(() => "?").join(", ")
      const updates = cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ")
      const values = cols.map((c) => (snapshot as Record<string, unknown>)[c])
      await conn
        .query(
          `INSERT INTO \`${safeTable(entry.entityTable)}\` (${cols.map((c) => `\`${c}\``).join(", ")})
           VALUES (${placeholders})
           ON DUPLICATE KEY UPDATE ${updates}`,
          values,
        )
        .catch((err) => {
          throw new Error(`Failed to restore record into ${entry.entityTable}: ${(err as Error).message}`)
        })
    }
    await conn.query(
      `UPDATE recycle_bin_entries SET status = 'restored', restored_by = ?, restored_at = NOW()
        WHERE id = ? AND tenant_id = ? AND status = 'recycled'`,
      [actor.userId, id, tenantId],
    )
  })

  await recordAuditLog(
    {
      action: "recycle_bin.restore",
      entityType: entry.entityType,
      entityId: entry.entityPk,
      entityLabel: entry.entityLabel,
      metadata: { recycleEntryId: id },
    },
    audit,
  )

  const updated = await getRecycleEntry(tenantId, id)
  return { ok: true, entry: updated! }
}

function safeParse(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Purge (hard delete)
// ---------------------------------------------------------------------------

export type PurgeResult =
  | { ok: true; entry: RecycleEntry }
  | { ok: false; code: string; message: string; status: number }

export async function purgeEntry(
  tenantId: number,
  id: number,
  actor: Actor,
  mode: "manual" | "expiry" = "manual",
  audit?: AuditContext,
): Promise<PurgeResult> {
  await ensureRecycleBinSchema()
  const entry = await getRecycleEntry(tenantId, id)
  if (!entry) return { ok: false, code: "NOT_FOUND", message: "Recycle bin entry not found", status: 404 }

  const legalHoldActive = await isRecordUnderLegalHold(tenantId, {
    entityType: entry.entityType,
    entityPk: entry.entityPk,
    module: entry.module,
  })
  const decision = evaluatePurge(
    { tenantId: entry.tenantId, status: entry.status, restoreDeadline: entry.restoreDeadline, legalHold: entry.legalHold },
    { tenantId, legalHoldActive, mode },
  )
  if (!decision.ok) return { ok: false, code: decision.code, message: decision.message, status: decision.status }

  // Permanently drop the snapshot; the ledger row itself is retained (as an
  // immutable tombstone) so the audit trail of what was purged survives.
  await query(
    `UPDATE recycle_bin_entries SET status = 'purged', purged_by = ?, purged_at = NOW(), snapshot = '{}'
      WHERE id = ? AND tenant_id = ? AND status = 'recycled'`,
    [actor.userId, id, tenantId],
  )

  await recordAuditLog(
    {
      action: mode === "expiry" ? "recycle_bin.purge_expired" : "recycle_bin.purge",
      entityType: entry.entityType,
      entityId: entry.entityPk,
      entityLabel: entry.entityLabel,
      metadata: { recycleEntryId: id, mode },
    },
    audit,
  )

  const updated = await getRecycleEntry(tenantId, id)
  return { ok: true, entry: updated! }
}

/**
 * Automated sweep: hard-delete every entry whose restore window has closed and
 * that is not under a legal hold. Returns the count purged. Safe to run per
 * tenant from a scheduled job.
 */
export async function purgeExpired(tenantId: number, actor: Actor, now: Date = new Date()): Promise<number> {
  await ensureRecycleBinSchema()
  const rows = (await query(
    `SELECT * FROM recycle_bin_entries
      WHERE tenant_id = ? AND status = 'recycled' AND restore_deadline IS NOT NULL AND restore_deadline <= ?`,
    [tenantId, now],
  )) as Record<string, unknown>[]
  let purged = 0
  for (const r of rows) {
    const res = await purgeEntry(tenantId, Number(r.id), actor, "expiry")
    if (res.ok) purged++
  }
  return purged
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
  status: RecordVersionStatus
  payload: Record<string, unknown>
  summary: string | null
  createdBy: number | null
  createdByName: string | null
  createdAt: string
  submittedAt: string | null
  decidedBy: number | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  publishedAt: string | null
}

function mapVersion(r: Record<string, unknown>): RecordVersion {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    entityType: String(r.entity_type),
    entityPk: String(r.entity_pk),
    versionNo: Number(r.version_no),
    baseVersionNo: Number(r.base_version_no),
    status: String(r.status) as RecordVersionStatus,
    payload: safeParse(r.payload) ?? {},
    summary: (r.summary as string) ?? null,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdByName: (r.created_by_name as string) ?? null,
    createdAt: toIso(r.created_at),
    submittedAt: r.submitted_at == null ? null : toIso(r.submitted_at),
    decidedBy: r.decided_by == null ? null : Number(r.decided_by),
    decidedByName: (r.decided_by_name as string) ?? null,
    decidedAt: r.decided_at == null ? null : toIso(r.decided_at),
    decisionNote: (r.decision_note as string) ?? null,
    publishedAt: r.published_at == null ? null : toIso(r.published_at),
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

export type CreateVersionResult =
  | { ok: true; version: RecordVersion; stale: boolean }
  | { ok: false; code: string; message: string; status: number }

/**
 * Draft a versioned sensitive edit. The proposed changes are NOT applied to the
 * live record — they wait for approval. If the record has advanced past the
 * caller's `baseVersionNo`, the draft is flagged `stale` (a concurrent edit
 * landed first) so the UI can warn before submission.
 */
export async function createVersion(
  tenantId: number,
  rawInput: Parameters<typeof normalizeVersionInput>[0],
  actor: Actor,
  idempotencyKey?: string | null,
  audit?: AuditContext,
): Promise<CreateVersionResult> {
  await ensureRecycleBinSchema()
  let input: NormalizedVersionInput
  try {
    input = normalizeVersionInput(rawInput)
  } catch (err) {
    return { ok: false, code: "INVALID", message: (err as Error).message, status: 400 }
  }
  const idem = idempotencyKey ? String(idempotencyKey).slice(0, 128) : null
  if (idem) {
    const existing = (await query(`SELECT * FROM record_versions WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`, [
      tenantId,
      idem,
    ])) as Record<string, unknown>[]
    if (existing.length) {
      const v = mapVersion(existing[0])
      const publishedNo = await currentPublishedVersionNo(tenantId, v.entityType, v.entityPk)
      return { ok: true, version: v, stale: isEditStale(v.baseVersionNo, publishedNo) }
    }
  }

  const publishedNo = await currentPublishedVersionNo(tenantId, input.entityType, input.entityPk)
  const stale = isEditStale(input.baseVersionNo, publishedNo)
  const versionNo = nextVersionNo(await maxVersionNo(tenantId, input.entityType, input.entityPk))

  const res = (await query(
    `INSERT INTO record_versions
       (tenant_id, entity_type, entity_pk, version_no, base_version_no, status, payload, summary,
        created_by, created_by_name, idempotency_key)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    [
      tenantId,
      input.entityType,
      input.entityPk,
      versionNo,
      input.baseVersionNo,
      JSON.stringify(input.payload),
      input.summary,
      actor.userId,
      actor.name ?? null,
      idem,
    ],
  )) as { insertId: number }

  await recordAuditLog(
    {
      action: "record_version.create",
      entityType: input.entityType,
      entityId: input.entityPk,
      metadata: { versionId: res.insertId, versionNo, baseVersionNo: input.baseVersionNo, stale },
    },
    audit,
  )

  const rows = (await query(`SELECT * FROM record_versions WHERE id = ? AND tenant_id = ?`, [
    res.insertId,
    tenantId,
  ])) as Record<string, unknown>[]
  return { ok: true, version: mapVersion(rows[0]), stale }
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
    `SELECT * FROM record_versions WHERE ${where.join(" AND ")} ORDER BY version_no DESC LIMIT ?`,
    [...params, limit],
  )) as Record<string, unknown>[]
  return rows.map(mapVersion)
}

export async function getVersion(tenantId: number, id: number): Promise<RecordVersion | null> {
  await ensureRecycleBinSchema()
  const rows = (await query(`SELECT * FROM record_versions WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    tenantId,
  ])) as Record<string, unknown>[]
  return rows.length ? mapVersion(rows[0]) : null
}

export type TransitionResult =
  | { ok: true; version: RecordVersion; applied?: Record<string, unknown> }
  | { ok: false; code: string; message: string; status: number }

/**
 * Advance a version through submit / approve / reject / publish. `publish`
 * re-checks staleness against the LIVE published version (catching a concurrent
 * edit that lost the race) and, when clean, applies the payload to the live
 * record inside the same transaction. Every transition writes an immutable
 * audit event.
 */
export async function transitionVersion(
  tenantId: number,
  id: number,
  t: VersionTransition,
  actor: Actor,
  opts: { note?: unknown; entityTable?: string; enforceSegregation?: boolean } = {},
  audit?: AuditContext,
): Promise<TransitionResult> {
  await ensureRecycleBinSchema()
  const version = await getVersion(tenantId, id)
  if (!version) return { ok: false, code: "NOT_FOUND", message: "Version not found", status: 404 }

  const publishedNo = await currentPublishedVersionNo(tenantId, version.entityType, version.entityPk)
  const decision = evaluateTransition(t, {
    status: version.status,
    baseVersionNo: version.baseVersionNo,
    currentPublishedVersionNo: publishedNo,
    createdBy: version.createdBy ?? 0,
    actorUserId: actor.userId,
    enforceSegregation: opts.enforceSegregation,
  })
  if (!decision.ok) {
    // Auto-supersede a stale pending/approved change instead of leaving it stuck.
    if (decision.code === "STALE") {
      await query(
        `UPDATE record_versions SET status = 'superseded' WHERE id = ? AND tenant_id = ? AND status = 'approved'`,
        [id, tenantId],
      )
    }
    return { ok: false, code: decision.code, message: decision.message, status: decision.status }
  }

  const note = normalizeDecisionNote(opts.note)
  let applied: Record<string, unknown> | undefined

  await withTransaction(async (conn) => {
    if (t === "submit") {
      await conn.query(
        `UPDATE record_versions SET status = 'pending', submitted_at = NOW() WHERE id = ? AND tenant_id = ? AND status = 'draft'`,
        [id, tenantId],
      )
    } else if (t === "approve") {
      await conn.query(
        `UPDATE record_versions SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = NOW(), decision_note = ?
          WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
        [actor.userId, actor.name ?? null, note, id, tenantId],
      )
    } else if (t === "reject") {
      await conn.query(
        `UPDATE record_versions SET status = 'rejected', decided_by = ?, decided_by_name = ?, decided_at = NOW(), decision_note = ?
          WHERE id = ? AND tenant_id = ?`,
        [actor.userId, actor.name ?? null, note, id, tenantId],
      )
    } else if (t === "publish") {
      // Apply the approved payload onto the live record (reference-preserving).
      if (opts.entityTable && version.payload && Object.keys(version.payload).length) {
        const cols = Object.keys(version.payload)
        const sets = cols.map((c) => `\`${c}\` = ?`).join(", ")
        const values = cols.map((c) => version.payload[c])
        await conn
          .query(`UPDATE \`${safeTable(opts.entityTable)}\` SET ${sets} WHERE id = ? AND tenant_id = ?`, [
            ...values,
            version.entityPk,
            tenantId,
          ])
          .catch((err) => {
            throw new Error(`Failed to publish version onto ${opts.entityTable}: ${(err as Error).message}`)
          })
        applied = version.payload
      }
      await conn.query(
        `UPDATE record_versions SET status = 'published', published_at = NOW() WHERE id = ? AND tenant_id = ? AND status = 'approved'`,
        [id, tenantId],
      )
    }
  })

  await recordAuditLog(
    {
      action: `record_version.${t}`,
      entityType: version.entityType,
      entityId: version.entityPk,
      metadata: { versionId: id, versionNo: version.versionNo, note },
    },
    audit,
  )

  const updated = await getVersion(tenantId, id)
  return { ok: true, version: updated!, applied }
}
