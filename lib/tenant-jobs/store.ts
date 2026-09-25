import "server-only"

import type { PoolConnection } from "mysql2/promise"
import { query, withTransaction } from "@/lib/db"
import { enqueueBackgroundJob, ensureBackgroundJobSchema } from "@/lib/background-jobs"
import { retryDeadLetter, RetryConflict } from "@/lib/job-manual-retry"
import {
  displayRunStatus,
  nextRunAt,
  planTenantJobTick,
  TENANT_JOB_ACTIONS,
  TENANT_JOB_LIMITS,
  TenantJobError,
  type TenantJobActionKey,
  type TenantJobInput,
  type TenantJobParams,
  type TenantJobRunDisplayStatus,
} from "@/lib/tenant-jobs/model"

/**
 * Tenant scheduled jobs — persistence + dispatch (Spec12, #22-29).
 *
 * Every read and write takes the tenant id from the verified guard and filters
 * on it; callers never pass a tenant id from the request body. Runs execute in
 * the shared durable queue (platform_background_jobs, job_type
 * `tenant.scheduled_job`) so the platform job monitor, retry policy, dead
 * letters and manual retry all apply unchanged.
 */

export type TenantJob = {
  id: number
  tenantId: number
  name: string
  actionKey: TenantJobActionKey
  actionParams: TenantJobParams
  presetKey: string
  cronExpression: string
  timezone: string
  startAt: string | null
  endAt: string | null
  enabled: boolean
  maxAttempts: number
  notifyOnFailure: boolean
  notifyOnSuccess: boolean
  notifyEmails: string[]
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  version: number
  ownerUserId: number
  createdAt: string
  updatedAt: string
}

export type TenantJobRun = {
  id: number
  scheduleId: number
  triggerSource: "scheduler" | "manual"
  scheduledFor: string
  status: TenantJobRunDisplayStatus
  skipReason: string | null
  attempts: number
  maxAttempts: number
  backgroundJobId: number | null
  nextRetryAt: string | null
  errorMessage: string | null
  result: Record<string, unknown> | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export class TenantJobConflict extends Error {}
export class TenantJobNotFound extends Error {}

/** DATETIME columns hold UTC; the pool returns them as strings (dateStrings). */
export function toSqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ")
}
export function fromSqlUtc(value: unknown): string | null {
  if (!value) return null
  const text = String(value)
  return /Z$|[+-]\d\d:\d\d$/.test(text) ? new Date(text).toISOString() : new Date(`${text.replace(" ", "T")}Z`).toISOString()
}
const asDate = (value: unknown) => {
  const iso = fromSqlUtc(value)
  return iso ? new Date(iso) : null
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try { return JSON.parse(String(value)) as T } catch { return fallback }
}

function mapJob(row: any): TenantJob {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    name: row.name,
    actionKey: row.action_key,
    actionParams: json(row.action_params, {} as TenantJobParams),
    presetKey: row.preset_key,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    startAt: fromSqlUtc(row.start_at),
    endAt: fromSqlUtc(row.end_at),
    enabled: Boolean(row.enabled),
    maxAttempts: Number(row.max_attempts),
    notifyOnFailure: Boolean(row.notify_on_failure),
    notifyOnSuccess: Boolean(row.notify_on_success),
    notifyEmails: json<string[]>(row.notify_emails, []),
    nextRunAt: fromSqlUtc(row.next_run_at),
    lastRunAt: fromSqlUtc(row.last_run_at),
    lastStatus: row.last_status ?? null,
    version: Number(row.version),
    ownerUserId: Number(row.owner_user_id),
    createdAt: fromSqlUtc(row.created_at) ?? "",
    updatedAt: fromSqlUtc(row.updated_at) ?? "",
  }
}

export function mapRun(row: any): TenantJobRun {
  const attempts = Number(row.job_attempts ?? 0)
  return {
    id: Number(row.id),
    scheduleId: Number(row.schedule_id),
    triggerSource: row.trigger_source,
    scheduledFor: fromSqlUtc(row.scheduled_for) ?? "",
    status: displayRunStatus(row.status, row.job_status ?? null, attempts),
    skipReason: row.skip_reason ?? null,
    attempts,
    maxAttempts: Number(row.job_max_attempts ?? 0),
    backgroundJobId: row.background_job_id == null ? null : Number(row.background_job_id),
    nextRetryAt: row.job_status === "queued" && attempts > 0 ? fromSqlUtc(row.job_available_at) : null,
    errorMessage: row.error_message ?? row.job_error ?? null,
    result: json(row.result, null),
    startedAt: fromSqlUtc(row.started_at),
    finishedAt: fromSqlUtc(row.finished_at),
    createdAt: fromSqlUtc(row.created_at) ?? "",
  }
}

let ensured: Promise<void> | null = null
async function runEnsure() {
  await ensureBackgroundJobSchema()
  await query(`CREATE TABLE IF NOT EXISTS tenant_scheduled_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL,
    action_key VARCHAR(60) NOT NULL,
    action_params JSON NOT NULL,
    preset_key VARCHAR(40) NOT NULL DEFAULT 'custom',
    cron_expression VARCHAR(120) NOT NULL,
    timezone VARCHAR(64) NOT NULL,
    start_at DATETIME NULL,
    end_at DATETIME NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 3,
    notify_on_failure TINYINT(1) NOT NULL DEFAULT 1,
    notify_on_success TINYINT(1) NOT NULL DEFAULT 0,
    notify_emails JSON NULL,
    next_run_at DATETIME NULL,
    last_run_at DATETIME NULL,
    last_status VARCHAR(20) NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    create_key VARCHAR(160) NULL,
    owner_user_id BIGINT UNSIGNED NOT NULL,
    updated_by BIGINT UNSIGNED NULL,
    deleted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_tenant_job_create_key (tenant_id, create_key),
    KEY idx_tenant_job_due (enabled, deleted_at, next_run_at),
    KEY idx_tenant_job_tenant (tenant_id, deleted_at, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS tenant_scheduled_job_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NOT NULL,
    schedule_id BIGINT UNSIGNED NOT NULL,
    trigger_source ENUM('scheduler','manual') NOT NULL DEFAULT 'scheduler',
    dedupe_key VARCHAR(191) NOT NULL,
    scheduled_for DATETIME NOT NULL,
    status ENUM('pending','queued','running','succeeded','failed','skipped') NOT NULL DEFAULT 'pending',
    skip_reason VARCHAR(40) NULL,
    background_job_id BIGINT UNSIGNED NULL,
    result JSON NULL,
    error_message TEXT NULL,
    triggered_by BIGINT UNSIGNED NULL,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_tenant_job_run_dedupe (schedule_id, dedupe_key),
    KEY idx_tenant_job_run_history (tenant_id, schedule_id, created_at),
    KEY idx_tenant_job_run_pending (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}
export function ensureTenantJobSchema() {
  if (!ensured) ensured = runEnsure().catch((error) => { ensured = null; throw error })
  return ensured
}

const RUN_SELECT = `SELECT r.*, j.status AS job_status, j.attempts AS job_attempts, j.max_attempts AS job_max_attempts,
  j.available_at AS job_available_at, j.error_message AS job_error
  FROM tenant_scheduled_job_runs r
  LEFT JOIN platform_background_jobs j ON j.id = r.background_job_id AND j.tenant_id = r.tenant_id`

// ---------------------------------------------------------------------------
// CRUD (tenant-scoped)
// ---------------------------------------------------------------------------

export async function listTenantJobs(tenantId: number): Promise<TenantJob[]> {
  await ensureTenantJobSchema()
  const rows = await query<any[]>("SELECT * FROM tenant_scheduled_jobs WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200", [tenantId])
  return rows.map(mapJob)
}

export async function getTenantJob(tenantId: number, id: number): Promise<TenantJob | null> {
  await ensureTenantJobSchema()
  const rows = await query<any[]>("SELECT * FROM tenant_scheduled_jobs WHERE tenant_id=? AND id=? AND deleted_at IS NULL LIMIT 1", [tenantId, id])
  return rows[0] ? mapJob(rows[0]) : null
}

function scheduleColumns(input: TenantJobInput, now: Date) {
  const next = input.enabled ? nextRunAt(input.cronExpression, input.timezone, now, { startAt: input.startAt, endAt: input.endAt }) : null
  return [
    input.name, input.actionKey, JSON.stringify(input.actionParams), input.presetKey, input.cronExpression, input.timezone,
    input.startAt ? toSqlUtc(input.startAt) : null, input.endAt ? toSqlUtc(input.endAt) : null,
    input.enabled ? 1 : 0, input.maxAttempts, input.notifyOnFailure ? 1 : 0, input.notifyOnSuccess ? 1 : 0,
    JSON.stringify(input.notifyEmails), next ? toSqlUtc(next) : null,
  ]
}

export async function createTenantJob(tenantId: number, actorId: number, input: TenantJobInput, createKey: string | null, now = new Date()): Promise<{ job: TenantJob; replayed: boolean }> {
  await ensureTenantJobSchema()
  const key = createKey?.trim().slice(0, 160) || null
  if (key) {
    const existing = await query<any[]>("SELECT * FROM tenant_scheduled_jobs WHERE tenant_id=? AND create_key=? LIMIT 1", [tenantId, key])
    if (existing[0]) return { job: mapJob(existing[0]), replayed: true }
  }
  const [{ count }] = await query<any[]>("SELECT COUNT(*) AS count FROM tenant_scheduled_jobs WHERE tenant_id=? AND deleted_at IS NULL", [tenantId])
  if (Number(count) >= TENANT_JOB_LIMITS.maxSchedulesPerTenant) throw new TenantJobConflict(`A tenant can have at most ${TENANT_JOB_LIMITS.maxSchedulesPerTenant} scheduled jobs`)
  try {
    const res = await query<any>(
      `INSERT INTO tenant_scheduled_jobs (name, action_key, action_params, preset_key, cron_expression, timezone, start_at, end_at,
        enabled, max_attempts, notify_on_failure, notify_on_success, notify_emails, next_run_at, tenant_id, owner_user_id, updated_by, create_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...scheduleColumns(input, now), tenantId, actorId, actorId, key],
    )
    return { job: (await getTenantJob(tenantId, Number(res.insertId)))!, replayed: false }
  } catch (error: any) {
    if (error?.code !== "ER_DUP_ENTRY" || !key) throw error
    const rows = await query<any[]>("SELECT * FROM tenant_scheduled_jobs WHERE tenant_id=? AND create_key=? LIMIT 1", [tenantId, key])
    return { job: mapJob(rows[0]), replayed: true }
  }
}

/** Full replace guarded by optimistic `version`. Recomputes next_run_at. */
export async function updateTenantJob(tenantId: number, actorId: number, id: number, input: TenantJobInput, expectedVersion: number, now = new Date()): Promise<TenantJob> {
  await ensureTenantJobSchema()
  const res = await query<any>(
    `UPDATE tenant_scheduled_jobs SET name=?, action_key=?, action_params=?, preset_key=?, cron_expression=?, timezone=?, start_at=?, end_at=?,
      enabled=?, max_attempts=?, notify_on_failure=?, notify_on_success=?, notify_emails=?, next_run_at=?, updated_by=?, version=version+1
     WHERE tenant_id=? AND id=? AND version=? AND deleted_at IS NULL`,
    [...scheduleColumns(input, now), actorId, tenantId, id, expectedVersion],
  )
  if (Number(res.affectedRows) !== 1) {
    if (!(await getTenantJob(tenantId, id))) throw new TenantJobNotFound("Scheduled job not found")
    throw new TenantJobConflict("This job was changed by someone else. Refresh and try again.")
  }
  return (await getTenantJob(tenantId, id))!
}

export async function setTenantJobEnabled(tenantId: number, actorId: number, id: number, enabled: boolean, expectedVersion: number, now = new Date()): Promise<TenantJob> {
  const job = await getTenantJob(tenantId, id)
  if (!job) throw new TenantJobNotFound("Scheduled job not found")
  const next = enabled ? nextRunAt(job.cronExpression, job.timezone, now, { startAt: asDate(job.startAt), endAt: asDate(job.endAt) }) : null
  const res = await query<any>(
    "UPDATE tenant_scheduled_jobs SET enabled=?, next_run_at=?, updated_by=?, version=version+1 WHERE tenant_id=? AND id=? AND version=? AND deleted_at IS NULL",
    [enabled ? 1 : 0, next ? toSqlUtc(next) : null, actorId, tenantId, id, expectedVersion],
  )
  if (Number(res.affectedRows) !== 1) throw new TenantJobConflict("This job was changed by someone else. Refresh and try again.")
  return (await getTenantJob(tenantId, id))!
}

/** Soft delete; history is retained. Queued runs are skipped by the handler. */
export async function deleteTenantJob(tenantId: number, actorId: number, id: number): Promise<boolean> {
  await ensureTenantJobSchema()
  const res = await query<any>(
    "UPDATE tenant_scheduled_jobs SET deleted_at=UTC_TIMESTAMP(), enabled=0, next_run_at=NULL, updated_by=?, version=version+1 WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    [actorId, tenantId, id],
  )
  return Number(res.affectedRows) === 1
}

export async function listTenantJobRuns(tenantId: number, scheduleId: number, limit = 50): Promise<TenantJobRun[]> {
  await ensureTenantJobSchema()
  const bounded = Math.min(200, Math.max(1, Math.floor(limit)))
  const rows = await query<any[]>(`${RUN_SELECT} WHERE r.tenant_id=? AND r.schedule_id=? ORDER BY r.created_at DESC, r.id DESC LIMIT ${bounded}`, [tenantId, scheduleId])
  return rows.map(mapRun)
}

export async function tenantJobOverview(tenantId: number) {
  await ensureTenantJobSchema()
  const rows = await query<any[]>(`${RUN_SELECT} WHERE r.tenant_id=? AND r.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) ORDER BY r.id DESC LIMIT 1000`, [tenantId])
  const counts: Partial<Record<TenantJobRunDisplayStatus, number>> = {}
  for (const run of rows.map(mapRun)) counts[run.status] = (counts[run.status] ?? 0) + 1
  return counts
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function insertRun(c: PoolConnection, run: { tenantId: number; scheduleId: number; source: "scheduler" | "manual"; dedupeKey: string; scheduledFor: Date; status: "pending" | "skipped"; skipReason?: string | null; triggeredBy?: number | null }): Promise<number | null> {
  const [res] = await c.query<any>(
    `INSERT IGNORE INTO tenant_scheduled_job_runs (tenant_id, schedule_id, trigger_source, dedupe_key, scheduled_for, status, skip_reason, triggered_by, finished_at)
     VALUES (?,?,?,?,?,?,?,?,IF(?='skipped',UTC_TIMESTAMP(),NULL))`,
    [run.tenantId, run.scheduleId, run.source, run.dedupeKey.slice(0, 191), toSqlUtc(run.scheduledFor), run.status, run.skipReason ?? null, run.triggeredBy ?? null, run.status],
  )
  return Number(res.affectedRows) === 1 ? Number(res.insertId) : null
}

/** Enqueue a pending run into the shared queue. Idempotent per run id. */
async function enqueueRun(runId: number, tenantId: number, maxAttempts: number, source: "scheduler" | "manual", actorId: number | null) {
  const job = await enqueueBackgroundJob({
    jobType: "tenant.scheduled_job",
    payload: { runId },
    tenantId,
    triggerSource: source === "manual" ? "user_request" : "scheduler",
    maxAttempts,
    backoffSeconds: 60,
    timeoutSeconds: 300,
    concurrencyKey: `tenant-scheduled:${tenantId}`,
    concurrencyLimit: TENANT_JOB_LIMITS.concurrencyPerTenant,
    idempotencyKey: `tenant-job-run:${runId}`,
    createdBy: actorId,
  })
  await query("UPDATE tenant_scheduled_job_runs SET background_job_id=?, status=IF(status='pending','queued',status) WHERE id=? AND tenant_id=?", [job.id, runId, tenantId])
  return job
}

export type DispatchSummary = { considered: number; dispatched: number; skipped: number; deferred: number; requeued: number; errors: number }

/**
 * One scheduler tick. Safe under duplicate/overlapping ticks:
 *  - each schedule row is locked FOR UPDATE and its slot consumed by advancing
 *    next_run_at in the same transaction (planTenantJobTick);
 *  - the run row is unique on (schedule_id, `slot:<iso>`), so even a replayed
 *    slot inserts nothing;
 *  - enqueueing uses idempotency key `tenant-job-run:<runId>`.
 * Disabled/suspended tenants get a `skipped` run and keep advancing so they do
 * not accumulate a backlog. A per-tenant cap bounds one tick's dispatches;
 * shared-queue concurrency then bounds per-tenant execution.
 */
export async function dispatchDueTenantJobs(now = new Date()): Promise<DispatchSummary> {
  await ensureTenantJobSchema()
  const summary: DispatchSummary = { considered: 0, dispatched: 0, skipped: 0, deferred: 0, requeued: 0, errors: 0 }
  const due = await query<any[]>(
    "SELECT id, tenant_id FROM tenant_scheduled_jobs WHERE enabled=1 AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at ASC, id ASC LIMIT 500",
    [toSqlUtc(now)],
  )
  const perTenant = new Map<number, number>()
  for (const candidate of due) {
    summary.considered++
    const tenantId = Number(candidate.tenant_id)
    const used = perTenant.get(tenantId) ?? 0
    if (used >= TENANT_JOB_LIMITS.dispatchPerTenantPerTick) { summary.deferred++; continue }
    try {
      const outcome = await withTransaction(async (c) => {
        const [rows] = await c.query<any[]>(
          `SELECT s.*, COALESCE(t.status, 'inactive') AS tenant_status FROM tenant_scheduled_jobs s
           LEFT JOIN tenants t ON t.id = s.tenant_id
           WHERE s.id=? AND s.deleted_at IS NULL FOR UPDATE`,
          [candidate.id],
        )
        const row = rows[0]
        if (!row) return null
        const plan = planTenantJobTick({
          enabled: Boolean(row.enabled),
          nextRunAt: asDate(row.next_run_at),
          startAt: asDate(row.start_at),
          endAt: asDate(row.end_at),
          cronExpression: row.cron_expression,
          timezone: row.timezone,
          tenantStatus: String(row.tenant_status),
        }, now)
        if (plan.kind === "wait") return null
        const runStatus = plan.kind === "dispatch" ? "pending" : "skipped"
        const runId = await insertRun(c, {
          tenantId, scheduleId: Number(row.id), source: "scheduler", dedupeKey: `slot:${plan.slot.toISOString()}`,
          scheduledFor: plan.slot, status: runStatus, skipReason: plan.kind === "skip" ? plan.skipReason ?? "ended" : null,
        })
        await c.query(
          "UPDATE tenant_scheduled_jobs SET next_run_at=?, last_run_at=?, last_status=?, enabled=IF(? IS NULL AND end_at IS NOT NULL, 0, enabled) WHERE id=?",
          [plan.nextRunAt ? toSqlUtc(plan.nextRunAt) : null, toSqlUtc(plan.slot), plan.kind === "dispatch" ? "queued" : "skipped", plan.nextRunAt ? toSqlUtc(plan.nextRunAt) : null, row.id],
        )
        return { plan, runId, maxAttempts: Number(row.max_attempts) }
      })
      if (!outcome) continue
      if (outcome.plan.kind === "skip") { summary.skipped++; continue }
      if (outcome.runId == null) continue
      await enqueueRun(outcome.runId, tenantId, outcome.maxAttempts, "scheduler", null)
      perTenant.set(tenantId, used + 1)
      summary.dispatched++
    } catch (error) {
      summary.errors++
      console.error("[tenant-jobs] dispatch failed", { scheduleId: candidate.id, error: error instanceof Error ? error.message : error })
    }
  }
  // Recover runs whose enqueue did not happen (crash between commit and enqueue).
  const stranded = await query<any[]>(
    `SELECT r.id, r.tenant_id, r.trigger_source, r.triggered_by, s.max_attempts FROM tenant_scheduled_job_runs r
     JOIN tenant_scheduled_jobs s ON s.id=r.schedule_id AND s.tenant_id=r.tenant_id
     WHERE r.status='pending' AND r.background_job_id IS NULL AND r.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE) LIMIT 100`,
  )
  for (const run of stranded) {
    try {
      await enqueueRun(Number(run.id), Number(run.tenant_id), Number(run.max_attempts), run.trigger_source, run.triggered_by == null ? null : Number(run.triggered_by))
      summary.requeued++
    } catch { summary.errors++ }
  }
  return summary
}

/** Run now. `requestKey` (Idempotency-Key) makes repeated clicks a no-op. */
export async function runTenantJobNow(tenantId: number, actorId: number, scheduleId: number, requestKey: string): Promise<{ run: TenantJobRun; replayed: boolean }> {
  await ensureTenantJobSchema()
  const job = await getTenantJob(tenantId, scheduleId)
  if (!job) throw new TenantJobNotFound("Scheduled job not found")
  const status = await query<any[]>("SELECT status FROM tenants WHERE id=? LIMIT 1", [tenantId])
  if (status[0] && status[0].status !== "active") throw new TenantJobConflict("This tenant is not active; jobs cannot run")
  const dedupeKey = `manual:${requestKey}`
  const runId = await withTransaction((c) => insertRun(c, { tenantId, scheduleId, source: "manual", dedupeKey, scheduledFor: new Date(), status: "pending", triggeredBy: actorId }))
  const id = runId ?? Number((await query<any[]>("SELECT id FROM tenant_scheduled_job_runs WHERE schedule_id=? AND tenant_id=? AND dedupe_key=? LIMIT 1", [scheduleId, tenantId, dedupeKey.slice(0, 191)]))[0]?.id)
  if (runId != null) await enqueueRun(runId, tenantId, job.maxAttempts, "manual", actorId)
  return { run: (await getTenantJobRun(tenantId, scheduleId, id))!, replayed: runId == null }
}

export async function getTenantJobRun(tenantId: number, scheduleId: number, runId: number): Promise<TenantJobRun | null> {
  await ensureTenantJobSchema()
  const rows = await query<any[]>(`${RUN_SELECT} WHERE r.tenant_id=? AND r.schedule_id=? AND r.id=? LIMIT 1`, [tenantId, scheduleId, runId])
  return rows[0] ? mapRun(rows[0]) : null
}

/** Reviewed manual retry of a dead-lettered run through the shared queue's retry. */
export async function retryTenantJobRun(tenantId: number, actorId: number, scheduleId: number, runId: number, expectedAttempt: number, acknowledgeUncertain: boolean) {
  const run = await getTenantJobRun(tenantId, scheduleId, runId)
  if (!run) throw new TenantJobNotFound("Run not found")
  if (!run.backgroundJobId || !["dead_letter", "failed"].includes(run.status)) throw new TenantJobConflict("Only failed or dead-lettered runs can be retried")
  if (!(await getTenantJob(tenantId, scheduleId))) throw new TenantJobNotFound("Scheduled job not found")
  try {
    await retryDeadLetter(run.backgroundJobId, expectedAttempt, actorId, acknowledgeUncertain)
  } catch (error) {
    if (error instanceof RetryConflict) throw new TenantJobConflict(error.message)
    throw error
  }
  await query("UPDATE tenant_scheduled_job_runs SET status='queued', finished_at=NULL WHERE id=? AND tenant_id=?", [runId, tenantId])
  return (await getTenantJobRun(tenantId, scheduleId, runId))!
}

// ---------------------------------------------------------------------------
// Queue execution (called by the shared background queue handler)
// ---------------------------------------------------------------------------

export async function executeTenantJobRun(runId: number, queueJob: { tenant_id: number; attempts: number }): Promise<Record<string, unknown>> {
  await ensureTenantJobSchema()
  const rows = await query<any[]>(
    `SELECT r.id AS run_id, r.status AS run_status, s.*, COALESCE(t.status,'inactive') AS tenant_status
     FROM tenant_scheduled_job_runs r
     JOIN tenant_scheduled_jobs s ON s.id=r.schedule_id AND s.tenant_id=r.tenant_id
     LEFT JOIN tenants t ON t.id=r.tenant_id
     WHERE r.id=? AND r.tenant_id=? LIMIT 1`,
    [runId, queueJob.tenant_id],
  )
  const row = rows[0]
  // Tenant id on the queue entry must match the run: blocks cross-tenant replay.
  if (!row) throw new TenantJobError("Run not found for this tenant")
  if (row.run_status === "succeeded") return { skipped: "already succeeded" }
  if (row.deleted_at) {
    await query("UPDATE tenant_scheduled_job_runs SET status='skipped', skip_reason='deleted', finished_at=UTC_TIMESTAMP() WHERE id=?", [runId])
    return { skipped: "schedule deleted" }
  }
  if (row.tenant_status !== "active") throw new TenantJobError("Tenant is disabled; run was not executed")
  await query("UPDATE tenant_scheduled_job_runs SET status='running', started_at=COALESCE(started_at, UTC_TIMESTAMP()), error_message=NULL WHERE id=?", [runId])
  const { runTenantJobAction } = await import("@/lib/tenant-jobs/actions")
  const job = mapJob(row)
  try {
    return await runTenantJobAction(job, runId)
  } catch (error) {
    if (error instanceof TenantJobError) throw error
    // Unknown failures: retry only actions that are safe to replay.
    const message = error instanceof Error ? error.message.slice(0, 500) : "Action failed"
    if (TENANT_JOB_ACTIONS[job.actionKey]?.retrySafe) throw new TenantJobError(message, "transient")
    throw error
  }
}

/** Mirror the queue's terminal/retry outcome onto the run row and notify. */
export async function onTenantJobRunSettled(runId: number, tenantId: number, queueStatus: string, errorMessage: string | null, result: Record<string, unknown> | void) {
  await ensureTenantJobSchema()
  const runStatus = queueStatus === "completed" ? "succeeded" : queueStatus === "queued" ? "queued" : "failed"
  await query(
    `UPDATE tenant_scheduled_job_runs SET status=IF(status='skipped','skipped',?), error_message=?, result=?, finished_at=IF(?='queued',NULL,UTC_TIMESTAMP()) WHERE id=? AND tenant_id=?`,
    [runStatus, errorMessage?.slice(0, 2000) ?? null, result ? JSON.stringify(result) : null, runStatus, runId, tenantId],
  )
  if (runStatus === "queued") return
  const rows = await query<any[]>(
    `SELECT s.*, r.scheduled_for FROM tenant_scheduled_job_runs r JOIN tenant_scheduled_jobs s ON s.id=r.schedule_id AND s.tenant_id=r.tenant_id WHERE r.id=? AND r.tenant_id=?`,
    [runId, tenantId],
  )
  if (!rows[0]) return
  const job = mapJob(rows[0])
  const display = queueStatus === "completed" ? "succeeded" : queueStatus === "dead_letter" ? "dead_letter" : "failed"
  await query("UPDATE tenant_scheduled_jobs SET last_status=? WHERE id=? AND tenant_id=?", [display, job.id, tenantId])
  const failed = display !== "succeeded"
  if ((failed && !job.notifyOnFailure) || (!failed && !job.notifyOnSuccess)) return
  const { notifyTenantJobOutcome } = await import("@/lib/tenant-jobs/actions")
  await notifyTenantJobOutcome(job, runId, display, errorMessage).catch((error) => console.error("[tenant-jobs] outcome notification failed", error))
}
