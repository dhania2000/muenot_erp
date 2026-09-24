import "server-only"
/**
 * SPEC 96 — Custom Module Framework: record service (Phase 3).
 * ---------------------------------------------------------------------------
 * Owns the RECORD side of the engine: capturing values against a module,
 * driving the optional per-module workflow, attachments, and computing the
 * module's reports. All validation, permission and workflow logic runs through
 * the pure model, so the same rules the browser renders are the ones the server
 * enforces — the client is never trusted.
 *
 * Every statement is tenant-scoped via the request context, and the generic
 * record table is always filtered by BOTH tenant_id and module_id so one
 * tenant's module can never surface another tenant's rows.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { ensureCustomModuleSchema } from "@/lib/custom-modules/schema"
import { getModuleById } from "@/lib/custom-modules/store"
import {
  type Attachment,
  type ModuleDefinition,
  type ModuleReport,
  applyTransition,
  canCreateRecord,
  canDeleteRecord,
  canEditRecord,
  initialState,
  normalizeAttachments,
  validateRecordValues,
} from "@/lib/custom-modules/model"
import { computeReport, type ReportResult } from "@/lib/custom-modules/reports"
import type { TenantRole } from "@/lib/role-model"

export type ModuleRecord = {
  id: number
  moduleId: number
  moduleVersion: number
  state: string | null
  values: Record<string, unknown>
  attachments: Attachment[]
  createdBy: number | null
  updatedBy: number | null
  createdAt: string
  updatedAt: string
}

type RecordRow = {
  id: number
  module_id: number
  module_version: number
  state: string | null
  values_json: string | null
  attachments_json: string | null
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToRecord(row: RecordRow): ModuleRecord {
  return {
    id: Number(row.id),
    moduleId: Number(row.module_id),
    moduleVersion: Number(row.module_version) || 1,
    state: row.state,
    values: parseJson<Record<string, unknown>>(row.values_json, {}),
    attachments: parseJson<Attachment[]>(row.attachments_json, []),
    createdBy: row.created_by == null ? null : Number(row.created_by),
    updatedBy: row.updated_by == null ? null : Number(row.updated_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const REC_COLUMNS = `id, module_id, module_version, state, values_json, attachments_json,
                     created_by, updated_by, created_at, updated_at`

type Denied = { ok: false; error: string; status: number }
type ValueErrors = { ok: false; errors: Record<string, string> }

/** All records for a module, newest first, optionally filtered by workflow state. */
export async function listRecords(moduleId: number, state?: string): Promise<ModuleRecord[]> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const params: unknown[] = [tenantId, moduleId]
  let sql = `SELECT ${REC_COLUMNS} FROM custom_module_records WHERE tenant_id = ? AND module_id = ?`
  if (state) {
    sql += ` AND state = ?`
    params.push(state)
  }
  sql += ` ORDER BY created_at DESC, id DESC`
  const rows = (await query(sql, params)) as RecordRow[]
  return rows.map(rowToRecord)
}

/** One record by id, scoped to both the tenant and the module. */
export async function getRecordById(moduleId: number, id: number): Promise<ModuleRecord | null> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT ${REC_COLUMNS} FROM custom_module_records WHERE tenant_id = ? AND module_id = ? AND id = ? LIMIT 1`,
    [tenantId, moduleId, id],
  )) as RecordRow[]
  return rows[0] ? rowToRecord(rows[0]) : null
}

/**
 * Create a record against a published module. Values are validated + coerced
 * through the pure model (formula fields derived, unknown keys dropped); the
 * record enters the workflow's initial state, and attachments are only kept
 * when the module allows them.
 */
export async function createRecord(
  moduleId: number,
  rawValues: Record<string, unknown>,
  rawAttachments: unknown,
  role: TenantRole,
  actor: number | null,
): Promise<{ ok: true; record: ModuleRecord } | Denied | ValueErrors> {
  const module = await getModuleById(moduleId)
  if (!module) return { ok: false, error: "Module not found.", status: 404 }
  if (module.status !== "published") {
    return { ok: false, error: "This module is not accepting records.", status: 409 }
  }
  if (!canCreateRecord(module.permissions, role)) {
    return { ok: false, error: "You do not have permission to create records here.", status: 403 }
  }

  const validation = validateRecordValues(module, rawValues)
  if (!validation.ok) return { ok: false, errors: validation.errors }

  const tenantId = requireCurrentTenantId()
  const state = initialState(module.workflow)
  const attachments = module.allowAttachments ? normalizeAttachments(rawAttachments) : []

  const result = (await query(
    `INSERT INTO custom_module_records
       (tenant_id, module_id, module_version, state, values_json, attachments_json, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      moduleId,
      module.version,
      state,
      JSON.stringify(validation.values),
      JSON.stringify(attachments),
      actor,
      actor,
    ],
  )) as { insertId?: number }

  const record = await getRecordById(moduleId, result.insertId ?? 0)
  if (!record) return { ok: false, error: "Could not record the entry.", status: 500 }
  return { ok: true, record }
}

/**
 * Update a record's values (and attachments). The workflow state is NOT changed
 * here — that goes through transitionRecord so the state machine stays the only
 * path that moves a record between states.
 */
export async function updateRecord(
  moduleId: number,
  id: number,
  rawValues: Record<string, unknown>,
  rawAttachments: unknown,
  role: TenantRole,
  actor: number | null,
): Promise<{ ok: true; record: ModuleRecord } | Denied | ValueErrors> {
  const module = await getModuleById(moduleId)
  if (!module) return { ok: false, error: "Module not found.", status: 404 }
  if (!canEditRecord(module.permissions, role)) {
    return { ok: false, error: "You do not have permission to edit records here.", status: 403 }
  }

  const existing = await getRecordById(moduleId, id)
  if (!existing) return { ok: false, error: "Record not found.", status: 404 }

  const validation = validateRecordValues(module, rawValues)
  if (!validation.ok) return { ok: false, errors: validation.errors }

  const tenantId = requireCurrentTenantId()
  const attachments = module.allowAttachments
    ? normalizeAttachments(rawAttachments ?? existing.attachments)
    : []

  await query(
    `UPDATE custom_module_records
        SET values_json = ?, attachments_json = ?, updated_by = ?
      WHERE tenant_id = ? AND module_id = ? AND id = ?`,
    [JSON.stringify(validation.values), JSON.stringify(attachments), actor, tenantId, moduleId, id],
  )

  const record = await getRecordById(moduleId, id)
  if (!record) return { ok: false, error: "Could not update the record.", status: 500 }
  return { ok: true, record }
}

/** Delete a record, scoped to both the tenant and the module. */
export async function deleteRecord(
  moduleId: number,
  id: number,
  role: TenantRole,
): Promise<{ ok: true } | Denied> {
  const module = await getModuleById(moduleId)
  if (!module) return { ok: false, error: "Module not found.", status: 404 }
  if (!canDeleteRecord(module.permissions, role)) {
    return { ok: false, error: "You do not have permission to delete records here.", status: 403 }
  }
  const tenantId = requireCurrentTenantId()
  const res = (await query(
    `DELETE FROM custom_module_records WHERE tenant_id = ? AND module_id = ? AND id = ?`,
    [tenantId, moduleId, id],
  )) as { affectedRows?: number }
  if (!res.affectedRows) return { ok: false, error: "Record not found.", status: 404 }
  return { ok: true }
}

/**
 * Move a record between workflow states. The legal transition and the actor's
 * authority are re-derived from the module's live workflow — the client cannot
 * force a state.
 */
export async function transitionRecord(
  moduleId: number,
  id: number,
  toState: string,
  role: TenantRole,
  actor: number | null,
): Promise<{ ok: true; record: ModuleRecord } | Denied> {
  const module = await getModuleById(moduleId)
  if (!module) return { ok: false, error: "Module not found.", status: 404 }

  const existing = await getRecordById(moduleId, id)
  if (!existing) return { ok: false, error: "Record not found.", status: 404 }

  const transition = applyTransition(module.workflow, existing.state, toState, role)
  if (!transition.ok) return { ok: false, error: transition.error, status: 403 }

  const tenantId = requireCurrentTenantId()
  await query(
    `UPDATE custom_module_records SET state = ?, updated_by = ? WHERE tenant_id = ? AND module_id = ? AND id = ?`,
    [transition.to, actor, tenantId, moduleId, id],
  )

  const record = await getRecordById(moduleId, id)
  if (!record) return { ok: false, error: "Could not update the record.", status: 500 }
  return { ok: true, record }
}

/** Count records per workflow state for a module (for list-view badges). */
export async function recordStateCounts(moduleId: number): Promise<Record<string, number>> {
  await ensureCustomModuleSchema()
  const tenantId = requireCurrentTenantId()
  const rows = (await query(
    `SELECT COALESCE(state, '') AS state, COUNT(*) AS n FROM custom_module_records
      WHERE tenant_id = ? AND module_id = ? GROUP BY state`,
    [tenantId, moduleId],
  )) as { state: string; n: number }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[r.state || "—"] = Number(r.n)
  return out
}

/** Run one of the module's configured reports over all of its records. */
export async function runReport(
  module: ModuleDefinition,
  report: ModuleReport,
): Promise<ReportResult> {
  const records = await listRecords(module.id ?? 0)
  return computeReport(
    module,
    report,
    records.map((r) => r.values),
  )
}
