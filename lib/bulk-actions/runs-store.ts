import "server-only"
/**
 * durable record of every bulk run.
 *
 * One row per submission. Holds the request (resource/action/value/ids), the
 * actor snapshot (so a background worker can execute without a live session),
 * live progress counters, and the final partial-success report. The
 * `(tenant_id, idempotency_key)` unique index makes replays cheap: a retried
 * submission finds its existing run and returns the stored report instead of
 * re-applying the action. Self-heals its schema at runtime like the other
 * platform stores.
 */
import { query } from "@/lib/db"
import type { BulkActionKind, BulkActionReport } from "./types"

export type BulkRunStatus = "queued" | "running" | "completed" | "failed"

export type BulkRunActor = {
  userId: number
  name: string | null
  email: string | null
  role: "admin" | "employee"
}

export type BulkRun = {
  id: number
  tenantId: number
  resourceKey: string
  action: BulkActionKind
  status: BulkRunStatus
  actor: BulkRunActor
  ids: number[]
  value: Record<string, unknown> | null
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
  report: BulkActionReport | null
  error: string | null
  createdAt: string
  finishedAt: string | null
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS platform_bulk_action_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    resource_key VARCHAR(96) NOT NULL,
    action VARCHAR(32) NOT NULL,
    status ENUM('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
    idempotency_key VARCHAR(190) NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    actor_name VARCHAR(160) NULL,
    actor_email VARCHAR(190) NULL,
    actor_role VARCHAR(32) NULL,
    ids JSON NOT NULL,
    value JSON NULL,
    total INT UNSIGNED NOT NULL DEFAULT 0,
    processed INT UNSIGNED NOT NULL DEFAULT 0,
    succeeded INT UNSIGNED NOT NULL DEFAULT 0,
    failed INT UNSIGNED NOT NULL DEFAULT 0,
    skipped INT UNSIGNED NOT NULL DEFAULT 0,
    report JSON NULL,
    error TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_bulk_run_idempotency (tenant_id, idempotency_key),
    KEY idx_bulk_run_tenant (tenant_id, created_at),
    KEY idx_bulk_run_actor (actor_user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

export function ensureBulkRunSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((error) => { ensured = null; throw error })
  return ensured
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try { return JSON.parse(String(value)) as T } catch { return fallback }
}

function mapRun(row: any): BulkRun {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id ?? 0),
    resourceKey: row.resource_key,
    action: row.action,
    status: row.status,
    actor: {
      userId: Number(row.actor_user_id ?? 0),
      name: row.actor_name ?? null,
      email: row.actor_email ?? null,
      role: (row.actor_role as "admin" | "employee") ?? "employee",
    },
    ids: parseJson<number[]>(row.ids, []),
    value: parseJson<Record<string, unknown> | null>(row.value, null),
    total: Number(row.total ?? 0),
    processed: Number(row.processed ?? 0),
    succeeded: Number(row.succeeded ?? 0),
    failed: Number(row.failed ?? 0),
    skipped: Number(row.skipped ?? 0),
    report: parseJson<BulkActionReport | null>(row.report, null),
    error: row.error ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
  }
}

export type CreateBulkRunInput = {
  tenantId: number
  resourceKey: string
  action: BulkActionKind
  actor: BulkRunActor
  ids: number[]
  value: Record<string, unknown> | null
  idempotencyKey?: string | null
  status: BulkRunStatus
}

/**
 * Insert a run, or — when an idempotency key collides — return the existing run
 * unchanged. `created` is false on a replay so the caller can short-circuit.
 */
export async function createBulkRun(
  input: CreateBulkRunInput,
): Promise<{ run: BulkRun; created: boolean }> {
  await ensureBulkRunSchema()
  const key = input.idempotencyKey?.trim() || null
  try {
    const result = await query<any>(
      `INSERT INTO platform_bulk_action_runs
        (tenant_id, resource_key, action, status, idempotency_key, actor_user_id, actor_name, actor_email, actor_role, ids, value, total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.tenantId,
        input.resourceKey,
        input.action,
        input.status,
        key,
        input.actor.userId,
        input.actor.name,
        input.actor.email,
        input.actor.role,
        JSON.stringify(input.ids),
        input.value ? JSON.stringify(input.value) : null,
        input.ids.length,
      ],
    )
    const run = await getBulkRun(Number(result.insertId))
    if (!run) throw new Error("Bulk run could not be read after insert")
    return { run, created: true }
  } catch (error: any) {
    if (error?.code !== "ER_DUP_ENTRY" || !key) throw error
    const rows = await query<any[]>(
      "SELECT * FROM platform_bulk_action_runs WHERE tenant_id=? AND idempotency_key=? LIMIT 1",
      [input.tenantId, key],
    )
    if (!rows[0]) throw error
    return { run: mapRun(rows[0]), created: false }
  }
}

export async function getBulkRun(id: number): Promise<BulkRun | null> {
  await ensureBulkRunSchema()
  const rows = await query<any[]>("SELECT * FROM platform_bulk_action_runs WHERE id=? LIMIT 1", [id])
  return rows[0] ? mapRun(rows[0]) : null
}

/** Fetch a run scoped to a tenant (progress polling from the API). */
export async function getBulkRunForTenant(id: number, tenantId: number): Promise<BulkRun | null> {
  const run = await getBulkRun(id)
  if (!run || run.tenantId !== tenantId) return null
  return run
}

export async function markBulkRunRunning(id: number): Promise<void> {
  await ensureBulkRunSchema()
  await query("UPDATE platform_bulk_action_runs SET status='running' WHERE id=? AND status='queued'", [id])
}

export async function updateBulkRunProgress(
  id: number,
  progress: { processed: number; succeeded: number; failed: number; skipped: number },
): Promise<void> {
  await ensureBulkRunSchema()
  await query(
    "UPDATE platform_bulk_action_runs SET processed=?, succeeded=?, failed=?, skipped=? WHERE id=?",
    [progress.processed, progress.succeeded, progress.failed, progress.skipped, id],
  )
}

export async function completeBulkRun(id: number, report: BulkActionReport): Promise<void> {
  await ensureBulkRunSchema()
  await query(
    `UPDATE platform_bulk_action_runs
       SET status='completed', processed=?, succeeded=?, failed=?, skipped=?, report=?, finished_at=NOW()
     WHERE id=?`,
    [report.total, report.succeeded, report.failed, report.skipped, JSON.stringify(report), id],
  )
}

export async function failBulkRun(id: number, error: string): Promise<void> {
  await ensureBulkRunSchema()
  await query(
    "UPDATE platform_bulk_action_runs SET status='failed', error=?, finished_at=NOW() WHERE id=?",
    [error.slice(0, 4000), id],
  )
}
