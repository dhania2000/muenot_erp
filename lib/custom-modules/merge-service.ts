import "server-only"
/**
 * SPEC 104 — Record Merge Engine: transactional service (Phase 2).
 * ---------------------------------------------------------------------------
 * Owns the persistence, tenant scoping, transaction and audit trail around the
 * pure merge model (merge.ts). A merge folds one or more duplicate SECONDARY
 * records into a surviving PRIMARY record of the same module:
 *
 *   1. The survivor keeps the operator-chosen value for every field and the
 *      union of all attachments (computed by the pure model).
 *   2. Related records whose relation field pointed at a retired secondary are
 *      repointed to the survivor, so no reference is left dangling.
 *   3. The secondaries become tombstones (merged_into = survivor) rather than
 *      being deleted, so the merge is auditable AND reversible.
 *   4. A full pre-merge snapshot is written to custom_module_merges, which is
 *      what powers the rollback.
 *
 * Every write happens inside ONE transaction (withTransaction), so a failure
 * mid-merge leaves the records exactly as they were. Every statement is scoped
 * by tenant_id AND module_id, so one tenant's merge can never touch another's
 * rows, and the acting role is re-checked here — the client is never trusted.
 */
import type { PoolConnection } from "mysql2/promise"
import { query, withTransaction } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureCustomModuleSchema } from "@/lib/custom-modules/schema"
import { getModuleById, listModules } from "@/lib/custom-modules/store"
import { getRecordById, type ModuleRecord } from "@/lib/custom-modules/service"
import {
  type ModuleDefinition,
  canDeleteRecord,
  canEditRecord,
  canViewModule,
} from "@/lib/custom-modules/model"
import {
  type FieldMergeChoice,
  type MergeSelections,
  type MergeSnapshot,
  type RecordSnapshot,
  type RewireSnapshot,
  computeMerge,
  rewireReferences,
  validateMergeRequest,
} from "@/lib/custom-modules/merge"
import { recordAuditLog } from "@/lib/audit-log-store"
import type { TenantRole } from "@/lib/role-model"

type Denied = { ok: false; error: string; status: number }

export type MergePreview = {
  primaryId: number
  secondaryIds: number[]
  fields: FieldMergeChoice[]
  mergedValues: Record<string, unknown>
  attachmentCount: number
  referenceChanges: number
}

export type MergeHistoryEntry = {
  id: number
  moduleId: number
  primaryId: number
  secondaryIds: number[]
  referenceChanges: number
  status: "merged" | "rolled_back"
  createdBy: number | null
  createdAt: string
  rolledBackBy: number | null
  rolledBackAt: string | null
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return fallback
  }
}

/** Re-check that the acting role may execute a merge on this module. */
function guardRole(module: ModuleDefinition, role: TenantRole): Denied | null {
  if (!canViewModule(module.permissions, role)) {
    return { ok: false, error: "You do not have access to this module.", status: 403 }
  }
  // A merge overwrites the survivor and retires the secondaries, so it demands
  // BOTH edit and delete authority.
  if (!canEditRecord(module.permissions, role) || !canDeleteRecord(module.permissions, role)) {
    return { ok: false, error: "Merging records requires edit and delete permission.", status: 403 }
  }
  return null
}

function toSnapshot(record: ModuleRecord): RecordSnapshot {
  return {
    id: record.id,
    state: record.state,
    values: record.values,
    attachments: record.attachments,
  }
}

/**
 * Scan every one of the tenant's module records for relation references that
 * point at one of the retired secondaries and plan the repoint to the survivor.
 * Records that are themselves part of the merge are skipped. Pure read — the
 * planned updates are applied later inside the merge transaction.
 */
async function planReferenceRewires(
  mergedRecordIds: ReadonlySet<number>,
  secondaryIds: ReadonlySet<string>,
  primaryId: string,
): Promise<{ updates: Array<{ moduleId: number; recordId: number; values: Record<string, unknown> }>; changes: RewireSnapshot[] }> {
  const updates: Array<{ moduleId: number; recordId: number; values: Record<string, unknown> }> = []
  const changes: RewireSnapshot[] = []

  const modules = await listModules()
  for (const module of modules) {
    // Only modules that actually carry an entity field can hold a reference.
    if (!module.fields.some((f) => f.type === "entity")) continue
    const tenantId = requireCurrentTenantId()
    const rows = (await query(
      `SELECT id, values_json FROM custom_module_records
        WHERE tenant_id = ? AND module_id = ? AND merged_into IS NULL`,
      [tenantId, module.id],
    )) as Array<{ id: number; values_json: unknown }>

    for (const row of rows) {
      const recordId = Number(row.id)
      if (mergedRecordIds.has(recordId)) continue
      const values = parseJson<Record<string, unknown>>(row.values_json, {})
      const rewired = rewireReferences(module, values, secondaryIds, primaryId)
      if (rewired.changes.length === 0) continue
      updates.push({ moduleId: module.id!, recordId, values: rewired.values })
      for (const c of rewired.changes) {
        changes.push({ recordId, key: c.key, from: c.from, to: c.to })
      }
    }
  }
  return { updates, changes }
}

/**
 * Validate a proposed merge and compute the survivor WITHOUT writing anything.
 * Shared by the preview endpoint and the executor, so the same rules run both
 * before the operator confirms and again at write time.
 */
export async function previewMerge(
  moduleId: number,
  primaryId: number,
  secondaryIds: readonly number[],
  selections: MergeSelections,
  role: TenantRole,
): Promise<{ ok: true; preview: MergePreview } | Denied> {
  await ensureCustomModuleSchema()

  const module = await getModuleById(moduleId)
  if (!module) return { ok: false, error: "Module not found.", status: 404 }
  const denied = guardRole(module, role)
  if (denied) return denied

  const validation = validateMergeRequest(primaryId, secondaryIds)
  if (!validation.ok) return { ok: false, error: validation.error, status: 400 }

  const primary = await getRecordById(moduleId, primaryId)
  if (!primary) return { ok: false, error: "The primary record was not found.", status: 404 }

  const secondaries: ModuleRecord[] = []
  for (const id of validation.secondaryIds) {
    const record = await getRecordById(moduleId, id)
    if (!record) return { ok: false, error: `Record ${id} was not found or is already merged.`, status: 404 }
    secondaries.push(record)
  }

  const computed = computeMerge(module, primary, secondaries, selections)
  const mergedIds = new Set<number>([primaryId, ...validation.secondaryIds])
  const secondaryIdSet = new Set(validation.secondaryIds.map(String))
  const { changes } = await planReferenceRewires(mergedIds, secondaryIdSet, String(primaryId))

  return {
    ok: true,
    preview: {
      primaryId,
      secondaryIds: validation.secondaryIds,
      fields: computed.fields,
      mergedValues: computed.values,
      attachmentCount: computed.attachments.length,
      referenceChanges: changes.length,
    },
  }
}

/**
 * Execute the merge inside one transaction: overwrite the survivor, repoint
 * related references, tombstone the secondaries and write the reversible
 * snapshot. On any failure the whole transaction rolls back, leaving every
 * record untouched.
 */
export async function mergeRecords(
  moduleId: number,
  primaryId: number,
  secondaryIds: readonly number[],
  selections: MergeSelections,
  role: TenantRole,
  actor: number | null,
): Promise<{ ok: true; mergeId: number; record: ModuleRecord } | Denied> {
  const module = await getModuleById(moduleId)
  if (!module) return { ok: false, error: "Module not found.", status: 404 }
  const denied = guardRole(module, role)
  if (denied) return denied

  const validation = validateMergeRequest(primaryId, secondaryIds)
  if (!validation.ok) return { ok: false, error: validation.error, status: 400 }

  const primary = await getRecordById(moduleId, primaryId)
  if (!primary) return { ok: false, error: "The primary record was not found.", status: 404 }

  const secondaries: ModuleRecord[] = []
  for (const id of validation.secondaryIds) {
    const record = await getRecordById(moduleId, id)
    if (!record) return { ok: false, error: `Record ${id} was not found or is already merged.`, status: 404 }
    secondaries.push(record)
  }

  const computed = computeMerge(module, primary, secondaries, selections)
  const mergedIds = new Set<number>([primaryId, ...validation.secondaryIds])
  const secondaryIdSet = new Set(validation.secondaryIds.map(String))
  const rewires = await planReferenceRewires(mergedIds, secondaryIdSet, String(primaryId))

  const snapshot: MergeSnapshot = {
    primary: toSnapshot(primary),
    secondaries: secondaries.map(toSnapshot),
    rewires: rewires.changes,
  }

  const tenantId = requireCurrentTenantId()

  const mergeId = await withTransaction(async (conn: PoolConnection) => {
    // 1. Overwrite the survivor with the merged values + unioned attachments.
    await conn.query(
      `UPDATE custom_module_records
          SET values_json = ?, attachments_json = ?, updated_by = ?
        WHERE tenant_id = ? AND module_id = ? AND id = ? AND merged_into IS NULL`,
      [JSON.stringify(computed.values), JSON.stringify(computed.attachments), actor, tenantId, moduleId, primaryId],
    )

    // 2. Repoint every related record's reference to the survivor.
    for (const update of rewires.updates) {
      await conn.query(
        `UPDATE custom_module_records
            SET values_json = ?, updated_by = ?
          WHERE tenant_id = ? AND module_id = ? AND id = ? AND merged_into IS NULL`,
        [JSON.stringify(update.values), actor, tenantId, update.moduleId, update.recordId],
      )
    }

    // 3. Tombstone the secondaries (soft-retire, never deleted).
    for (const id of validation.secondaryIds) {
      await conn.query(
        `UPDATE custom_module_records
            SET merged_into = ?, merged_at = NOW(), updated_by = ?
          WHERE tenant_id = ? AND module_id = ? AND id = ? AND merged_into IS NULL`,
        [primaryId, actor, tenantId, moduleId, id],
      )
    }

    // 4. Record the reversible merge history row.
    const [result] = (await conn.query(
      `INSERT INTO custom_module_merges
         (tenant_id, module_id, module_version, primary_id, secondary_ids_json, field_sources_json,
          snapshot_json, reference_changes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'merged', ?)`,
      [
        tenantId,
        moduleId,
        module.version,
        primaryId,
        JSON.stringify(validation.secondaryIds),
        JSON.stringify(selections ?? {}),
        JSON.stringify(snapshot),
        rewires.changes.length,
        actor,
      ],
    )) as [{ insertId?: number }, unknown]
    return Number(result.insertId ?? 0)
  })

  void recordAuditLog({
    action: "custom_module.record_merge",
    entityType: `custom:${module.slug}`,
    entityId: primaryId,
    entityLabel: module.name,
    before: { primary: snapshot.primary.values },
    after: { primary: computed.values },
    metadata: {
      mergeId,
      secondaryIds: validation.secondaryIds,
      referenceChanges: rewires.changes.length,
      attachmentCount: computed.attachments.length,
    },
    context: { tenantId, actorUserId: actor },
  })

  const record = await getRecordById(moduleId, primaryId)
  if (!record) return { ok: false, error: "The merged record could not be reloaded.", status: 500 }
  return { ok: true, mergeId, record }
}

/** The merge history for a module, newest first. */
export async function listMerges(moduleId: number): Promise<MergeHistoryEntry[]> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT id, module_id, primary_id, secondary_ids_json, reference_changes, status,
            created_by, created_at, rolled_back_by, rolled_back_at
       FROM custom_module_merges
      WHERE tenant_id = ? AND module_id = ?
      ORDER BY created_at DESC, id DESC`,
    [tenantId, moduleId],
  )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    moduleId: Number(r.module_id),
    primaryId: Number(r.primary_id),
    secondaryIds: parseJson<number[]>(r.secondary_ids_json, []),
    referenceChanges: Number(r.reference_changes) || 0,
    status: (r.status === "rolled_back" ? "rolled_back" : "merged") as "merged" | "rolled_back",
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: String(r.created_at),
    rolledBackBy: r.rolled_back_by == null ? null : Number(r.rolled_back_by),
    rolledBackAt: r.rolled_back_at == null ? null : String(r.rolled_back_at),
  }))
}

/**
 * Reverse a completed merge from its stored snapshot inside one transaction:
 * restore the survivor's original values, revive the tombstoned secondaries,
 * undo the reference repoints and mark the history row rolled back. Idempotent
 * against double-rollback (a row already rolled back is rejected).
 */
export async function rollbackMerge(
  moduleId: number,
  mergeId: number,
  role: TenantRole,
  actor: number | null,
): Promise<{ ok: true } | Denied> {
  await ensureCustomModuleSchema()

  const module = await getModuleById(moduleId)
  if (!module) return { ok: false, error: "Module not found.", status: 404 }
  const denied = guardRole(module, role)
  if (denied) return denied

  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT id, primary_id, snapshot_json, status FROM custom_module_merges
      WHERE tenant_id = ? AND module_id = ? AND id = ? LIMIT 1`,
    [tenantId, moduleId, mergeId],
  )) as Array<{ id: number; primary_id: number; snapshot_json: unknown; status: string }>
  const row = rows[0]
  if (!row) return { ok: false, error: "Merge record not found.", status: 404 }
  if (row.status === "rolled_back") return { ok: false, error: "This merge has already been rolled back.", status: 409 }

  const snapshot = parseJson<MergeSnapshot | null>(row.snapshot_json, null)
  if (!snapshot) return { ok: false, error: "The merge snapshot is unavailable; cannot roll back.", status: 422 }

  await withTransaction(async (conn: PoolConnection) => {
    // 1. Restore the survivor's pre-merge values + attachments.
    await conn.query(
      `UPDATE custom_module_records
          SET values_json = ?, attachments_json = ?, updated_by = ?
        WHERE tenant_id = ? AND module_id = ? AND id = ?`,
      [
        JSON.stringify(snapshot.primary.values),
        JSON.stringify(snapshot.primary.attachments),
        actor,
        tenantId,
        moduleId,
        snapshot.primary.id,
      ],
    )

    // 2. Revive every tombstoned secondary with its captured state.
    for (const sec of snapshot.secondaries) {
      await conn.query(
        `UPDATE custom_module_records
            SET merged_into = NULL, merged_at = NULL, state = ?, values_json = ?,
                attachments_json = ?, updated_by = ?
          WHERE tenant_id = ? AND module_id = ? AND id = ?`,
        [
          sec.state,
          JSON.stringify(sec.values),
          JSON.stringify(sec.attachments),
          actor,
          tenantId,
          moduleId,
          sec.id,
        ],
      )
    }

    // 3. Undo the reference repoints: point each rewired field back at its
    //    original secondary, but only when it still points at the survivor
    //    (so a later manual edit is never clobbered).
    for (const rw of snapshot.rewires) {
      const [recRows] = (await conn.query(
        `SELECT module_id, values_json FROM custom_module_records
          WHERE tenant_id = ? AND id = ? LIMIT 1`,
        [tenantId, rw.recordId],
      )) as [Array<{ module_id: number; values_json: unknown }>, unknown]
      const rec = recRows[0]
      if (!rec) continue
      const values = parseJson<Record<string, unknown>>(rec.values_json, {})
      const current = values[rw.key]
      if (current && typeof current === "object" && String((current as any).id ?? "") === rw.to) {
        values[rw.key] = { ...(current as Record<string, unknown>), id: rw.from }
        await conn.query(
          `UPDATE custom_module_records SET values_json = ?, updated_by = ?
            WHERE tenant_id = ? AND id = ?`,
          [JSON.stringify(values), actor, tenantId, rw.recordId],
        )
      }
    }

    // 4. Seal the history row as rolled back.
    await conn.query(
      `UPDATE custom_module_merges
          SET status = 'rolled_back', rolled_back_by = ?, rolled_back_at = NOW()
        WHERE tenant_id = ? AND module_id = ? AND id = ?`,
      [actor, tenantId, moduleId, mergeId],
    )
  })

  void recordAuditLog({
    action: "custom_module.record_merge_rollback",
    entityType: `custom:${module.slug}`,
    entityId: row.primary_id,
    entityLabel: module.name,
    metadata: { mergeId, revived: snapshot.secondaries.map((s) => s.id) },
    context: { tenantId, actorUserId: actor },
  })

  return { ok: true }
}
