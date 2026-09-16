import { query } from "@/lib/db"

/**
 * Phase 55 — Recruitment audit trail.
 *
 * A single shared audit table (`recruitment_audit`) that records every create,
 * update and delete performed through the config-driven Recruitment CRUD
 * factory. It mirrors the HR master audit pattern (`hr_master_audit`): one row
 * per change, capturing who did it, the business + numeric ids, and a JSON
 * old/new snapshot. Writes are best-effort — a logging failure must never block
 * the underlying business write.
 *
 * The schema is ensured idempotently at runtime (once per process) so it comes
 * online against the live database without a manual migration step, exactly
 * like the operational sub-module tables in `recruitment-crud.ts`.
 */

export type RecruitmentAuditAction = "create" | "update" | "delete"

let schemaReady: Promise<void> | null = null

export function ensureRecruitmentAuditSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS recruitment_audit (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        module VARCHAR(60) NOT NULL,
        table_name VARCHAR(80) NOT NULL,
        record_id VARCHAR(191) NULL,
        row_pk BIGINT UNSIGNED NULL,
        action VARCHAR(20) NOT NULL,
        user_id BIGINT UNSIGNED NULL,
        user_name VARCHAR(191) NULL,
        old_value JSON NULL,
        new_value JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_ra_module (module),
        KEY idx_ra_record (module, record_id),
        KEY idx_ra_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).then(() => undefined)
  }
  return schemaReady
}

/**
 * Reduce an update to just the fields that actually changed, so the audit row
 * stores a focused before/after instead of the whole record. Values are
 * compared as strings to ignore trivial type differences (e.g. 5 vs "5").
 */
function diffChanged(
  before: Record<string, any>,
  after: Record<string, any>,
): { old: Record<string, any>; new: Record<string, any> } | null {
  const old: Record<string, any> = {}
  const next: Record<string, any> = {}
  for (const key of Object.keys(after)) {
    if (key === "updated_at") continue
    const a = before?.[key]
    const b = after[key]
    const norm = (v: any) => (v === null || v === undefined ? "" : String(v))
    if (norm(a) !== norm(b)) {
      old[key] = a ?? null
      next[key] = b ?? null
    }
  }
  return Object.keys(next).length ? { old, new: next } : null
}

/** Strip system columns from a snapshot so the audit payload stays focused. */
function cleanSnapshot(row: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!row) return null
  const { created_at, updated_at, created_by_name, ...rest } = row
  return rest
}

export async function logRecruitmentAudit(entry: {
  module: string
  table: string
  recordId?: string | number | null
  rowPk?: number | null
  action: RecruitmentAuditAction
  userId?: number | null
  userName?: string | null
  oldValue?: Record<string, any> | null
  newValue?: Record<string, any> | null
}): Promise<void> {
  await ensureRecruitmentAuditSchema()

  let oldVal = entry.oldValue ?? null
  let newVal = entry.newValue ?? null

  // For updates, keep only the changed fields; skip the log entirely when a
  // PATCH did not actually change anything.
  if (entry.action === "update" && oldVal && newVal) {
    const changed = diffChanged(oldVal, newVal)
    if (!changed) return
    oldVal = changed.old
    newVal = changed.new
  } else {
    oldVal = cleanSnapshot(oldVal)
    newVal = cleanSnapshot(newVal)
  }

  await query(
    `INSERT INTO recruitment_audit
       (module, table_name, record_id, row_pk, action, user_id, user_name, old_value, new_value)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      entry.module,
      entry.table,
      entry.recordId !== undefined && entry.recordId !== null ? String(entry.recordId) : null,
      entry.rowPk ?? null,
      entry.action,
      entry.userId ?? null,
      entry.userName ?? null,
      oldVal ? JSON.stringify(oldVal) : null,
      newVal ? JSON.stringify(newVal) : null,
    ],
  )
}

export type RecruitmentAuditRow = {
  id: number
  module: string
  table_name: string
  record_id: string | null
  row_pk: number | null
  action: RecruitmentAuditAction
  user_id: number | null
  user_name: string | null
  old_value: Record<string, any> | null
  new_value: Record<string, any> | null
  created_at: string
}

/** Read the audit history for one record (or a whole module) newest-first. */
export async function readRecruitmentAudit(opts: {
  module: string
  recordId?: string | null
  limit?: number
}): Promise<RecruitmentAuditRow[]> {
  await ensureRecruitmentAuditSchema()
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500)
  const conditions = ["module = ?"]
  const args: any[] = [opts.module]
  if (opts.recordId) {
    conditions.push("record_id = ?")
    args.push(opts.recordId)
  }
  const rows = (await query(
    `SELECT * FROM recruitment_audit
      WHERE ${conditions.join(" AND ")}
      ORDER BY id DESC
      LIMIT ${limit}`,
    args,
  )) as any[]
  return rows.map((r) => ({
    ...r,
    old_value: typeof r.old_value === "string" ? safeParse(r.old_value) : r.old_value,
    new_value: typeof r.new_value === "string" ? safeParse(r.new_value) : r.new_value,
  })) as RecruitmentAuditRow[]
}

function safeParse(v: string): any {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}
