import "server-only"

import crypto from "crypto"
import { query, withTransaction } from "@/lib/db"
import { fingerprint } from "@/lib/job-idempotency"

/**
 * SPEC 42 — Durable background queue.
 *
 * Queue entries are data, never commands or URLs. A reviewed handler registry
 * determines the code that can run for each job type.
 */
export const BACKGROUND_JOB_TYPES = ["email.send"] as const
export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number]

export const BACKGROUND_JOB_STATUSES = ["queued", "running", "completed", "failed", "dead_letter", "cancelled"] as const
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number]

type EmailPayload = {
  to: string
  subject: string
  html: string
  cc?: string | string[]
  bcc?: string | string[]
  from?: string
  department?: "sales" | "hr" | "finance" | "operations" | "recruit"
  headers?: Record<string, string>
}

export type BackgroundJobPayload = EmailPayload

export type BackgroundJob = {
  id: number
  job_type: BackgroundJobType
  tenant_id: number
  payload: BackgroundJobPayload
  status: BackgroundJobStatus
  priority: number
  attempts: number
  max_attempts: number
  backoff_seconds: number
  timeout_seconds: number
  concurrency_key: string | null
  concurrency_limit: number
  idempotency_key: string
  available_at: string
  locked_at: string | null
  worker_id: string | null
  cancel_requested: boolean
  started_at: string | null
  completed_at: string | null
  result: Record<string, unknown> | null
  error_message: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

export type EnqueueBackgroundJobInput = {
  triggerSource?: "scheduler" | "user_request" | "system"
  jobType: BackgroundJobType
  payload: BackgroundJobPayload
  tenantId?: number | null
  priority?: number
  maxAttempts?: number
  backoffSeconds?: number
  timeoutSeconds?: number
  concurrencyKey?: string | null
  concurrencyLimit?: number
  idempotencyKey?: string
  createdBy?: number | null
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "object") return value as Record<string, unknown>
  try { return JSON.parse(String(value)) as Record<string, unknown> } catch { return null }
}

function mapJob(row: any): BackgroundJob {
  return {
    ...row,
    id: Number(row.id),
    tenant_id: Number(row.tenant_id ?? 0),
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    backoff_seconds: Number(row.backoff_seconds),
    timeout_seconds: Number(row.timeout_seconds),
    concurrency_limit: Number(row.concurrency_limit),
    cancel_requested: Boolean(row.cancel_requested),
    payload: parseJson(row.payload) ?? {},
    result: parseJson(row.result),
  } as BackgroundJob
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value ?? fallback)
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback
}

function validateEmailPayload(payload: unknown): EmailPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Background job payload must be an object")
  const value = payload as Record<string, unknown>
  const to = typeof value.to === "string" ? value.to.trim() : ""
  const subject = typeof value.subject === "string" ? value.subject.trim() : ""
  const html = typeof value.html === "string" ? value.html : ""
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("A valid email recipient is required")
  if (!subject || subject.length > 255) throw new Error("Email subject must contain 1 to 255 characters")
  if (!html || html.length > 200_000) throw new Error("Email HTML must contain 1 to 200000 characters")
  const department = value.department
  if (department != null && !["sales", "hr", "finance", "operations", "recruit"].includes(String(department))) throw new Error("Invalid email department")
  const headers = value.headers
  if (headers != null && (typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some((item) => typeof item !== "string"))) {
    throw new Error("Email headers must be string values")
  }
  return {
    to, subject, html,
    ...(typeof value.cc === "string" || Array.isArray(value.cc) ? { cc: value.cc as string | string[] } : {}),
    ...(typeof value.bcc === "string" || Array.isArray(value.bcc) ? { bcc: value.bcc as string | string[] } : {}),
    ...(typeof value.from === "string" ? { from: value.from } : {}),
    ...(department ? { department: department as EmailPayload["department"] } : {}),
    ...(headers ? { headers: headers as Record<string, string> } : {}),
  }
}

function validatePayload(jobType: BackgroundJobType, payload: unknown): BackgroundJobPayload {
  if (jobType === "email.send") return validateEmailPayload(payload)
  throw new Error("Unknown background job type")
}

let ensured: Promise<void> | null = null
async function runEnsure() {
  await query(`CREATE TABLE IF NOT EXISTS platform_background_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    job_type VARCHAR(80) NOT NULL,
    tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    payload JSON NOT NULL,
    status ENUM('queued','running','completed','failed','dead_letter','cancelled') NOT NULL DEFAULT 'queued',
    priority TINYINT UNSIGNED NOT NULL DEFAULT 5,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 3,
    backoff_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    timeout_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 300,
    concurrency_key VARCHAR(160) NULL,
    concurrency_limit TINYINT UNSIGNED NOT NULL DEFAULT 1,
    idempotency_key VARCHAR(160) NOT NULL,
    available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at DATETIME NULL,
    worker_id VARCHAR(120) NULL,
    cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    result JSON NULL,
    error_message TEXT NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_background_job_idempotency (job_type, tenant_id, idempotency_key),
    KEY idx_background_job_ready (status, available_at, priority),
    KEY idx_background_job_tenant (tenant_id, status, created_at),
    KEY idx_background_job_concurrency (concurrency_key, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS platform_background_job_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    job_id BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    detail JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY idx_background_job_event (job_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  const columns = await query<any[]>("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='platform_background_jobs' AND column_name='trigger_source'")
  if (!columns.length) {
    try {
      await query("ALTER TABLE platform_background_jobs ADD COLUMN trigger_source VARCHAR(30) NOT NULL DEFAULT 'unknown'")
    } catch (error: any) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error
    }
  }
}

export function ensureBackgroundJobSchema() {
  if (!ensured) ensured = runEnsure().catch((error) => { ensured = null; throw error })
  return ensured
}

async function appendEvent(jobId: number, eventType: string, detail: Record<string, unknown> = {}) {
  await query("INSERT INTO platform_background_job_events (job_id, event_type, detail) VALUES (?,?,?)", [jobId, eventType, JSON.stringify(detail)])
}

export async function enqueueBackgroundJob(input: EnqueueBackgroundJobInput): Promise<BackgroundJob> {
  if (!BACKGROUND_JOB_TYPES.includes(input.jobType)) throw new Error("Unknown background job type")
  const payload = validatePayload(input.jobType, input.payload)
  const tenantId = bounded(input.tenantId, 0, 0, Number.MAX_SAFE_INTEGER)
  const priority = bounded(input.priority, 5, 0, 9)
  const maxAttempts = bounded(input.maxAttempts, 3, 1, 10)
  const backoffSeconds = bounded(input.backoffSeconds, 30, 1, 3600)
  const timeoutSeconds = bounded(input.timeoutSeconds, 300, 5, 900)
  const concurrencyLimit = bounded(input.concurrencyLimit, 1, 1, 20)
  const concurrencyKey = input.concurrencyKey == null ? input.jobType : String(input.concurrencyKey).trim().slice(0, 160)
  const rawKey = (input.idempotencyKey ?? crypto.randomUUID()).trim()
  const idempotencyKey = rawKey.length > 160 ? fingerprint(rawKey) : rawKey
  if (!idempotencyKey) throw new Error("An idempotency key is required")
  await ensureBackgroundJobSchema()
  try {
    const result = await query<any>(
      `INSERT INTO platform_background_jobs
       (job_type, tenant_id, payload, priority, max_attempts, backoff_seconds, timeout_seconds, concurrency_key, concurrency_limit, idempotency_key, created_by, trigger_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [input.jobType, tenantId, JSON.stringify(payload), priority, maxAttempts, backoffSeconds, timeoutSeconds, concurrencyKey || null, concurrencyLimit, idempotencyKey, input.createdBy ?? null, input.triggerSource ?? "system"],
    )
    const job = await getBackgroundJob(Number(result.insertId))
    if (!job) throw new Error("Queued job could not be read")
    await appendEvent(job.id, "queued", { priority, maxAttempts, idempotencyKey })
    return job
  } catch (error: any) {
    if (error?.code !== "ER_DUP_ENTRY") throw error
    const rows = await query<any[]>("SELECT * FROM platform_background_jobs WHERE job_type=? AND tenant_id=? AND idempotency_key=? LIMIT 1", [input.jobType, tenantId, idempotencyKey])
    const existing = rows[0] ? mapJob(rows[0]) : null
    if (!existing) throw error
    if (fingerprint(existing.payload) !== fingerprint(payload)) throw new Error("Idempotency key reused with different job payload")
    return existing
  }
}

export async function enqueueEmailJob(input: Omit<EnqueueBackgroundJobInput, "jobType">) {
  return enqueueBackgroundJob({ ...input, jobType: "email.send" })
}

export async function getBackgroundJob(id: number): Promise<BackgroundJob | null> {
  await ensureBackgroundJobSchema()
  const rows = await query<any[]>("SELECT * FROM platform_background_jobs WHERE id=? LIMIT 1", [id])
  return rows[0] ? mapJob(rows[0]) : null
}

export async function listBackgroundJobs(input: { limit?: number; tenantId?: number; status?: BackgroundJobStatus } = {}): Promise<BackgroundJob[]> {
  await ensureBackgroundJobSchema()
  const where: string[] = []
  const params: any[] = []
  if (input.tenantId != null) { where.push("tenant_id=?"); params.push(bounded(input.tenantId, 0, 0, Number.MAX_SAFE_INTEGER)) }
  if (input.status) { where.push("status=?"); params.push(input.status) }
  const limit = bounded(input.limit, 100, 1, 200)
  const rows = await query<any[]>(`SELECT * FROM platform_background_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${limit}`, params)
  return rows.map(mapJob)
}

export async function getBackgroundJobStats(tenantId?: number) {
  await ensureBackgroundJobSchema()
  const rows = await query<{ status: BackgroundJobStatus; count: number }[]>(
    `SELECT status, COUNT(*) AS count FROM platform_background_jobs ${tenantId == null ? "" : "WHERE tenant_id=?"} GROUP BY status`,
    tenantId == null ? [] : [bounded(tenantId, 0, 0, Number.MAX_SAFE_INTEGER)],
  )
  return BACKGROUND_JOB_STATUSES.reduce<Record<BackgroundJobStatus, number>>((stats, status) => {
    stats[status] = Number(rows.find((row) => row.status === status)?.count ?? 0)
    return stats
  }, {} as Record<BackgroundJobStatus, number>)
}

export async function cancelBackgroundJob(id: number): Promise<BackgroundJob | null> {
  await ensureBackgroundJobSchema()
  const job = await getBackgroundJob(id)
  if (!job || ["completed", "failed", "dead_letter", "cancelled"].includes(job.status)) return job
  if (job.status === "queued") {
    await query("UPDATE platform_background_jobs SET status='cancelled', completed_at=NOW(), cancel_requested=1 WHERE id=? AND status='queued'", [id])
    await appendEvent(id, "cancelled", { phase: "queued" })
  } else {
    await query("UPDATE platform_background_jobs SET cancel_requested=1 WHERE id=? AND status='running'", [id])
    await appendEvent(id, "cancellation_requested")
  }
  return getBackgroundJob(id)
}

export function retryDelaySeconds(attempt: number, baseSeconds: number): number {
  return Math.min(3600, Math.max(1, baseSeconds) * 2 ** Math.max(0, attempt - 1))
}

async function recoverExpiredJobs(): Promise<number> {
  const rows = await query<any[]>("SELECT * FROM platform_background_jobs WHERE status='running' AND locked_at < DATE_SUB(NOW(), INTERVAL timeout_seconds SECOND) LIMIT 100")
  for (const row of rows) await failBackgroundJob(mapJob(row), "Job execution timed out; delivery outcome unknown", true)
  return rows.length
}

async function claimQueuedJobs(limit: number, workerId: string): Promise<BackgroundJob[]> {
  return withTransaction(async (connection) => {
    const [candidateRows] = await connection.query<any[]>(
      "SELECT * FROM platform_background_jobs WHERE status='queued' AND cancel_requested=0 AND available_at<=NOW() ORDER BY priority DESC, available_at ASC, id ASC LIMIT ? FOR UPDATE",
      [limit],
    )
    const claimed: BackgroundJob[] = []
    for (const row of candidateRows) {
      const job = mapJob(row)
      const executionId = crypto.randomUUID()
      if (job.concurrency_key) {
        const [countRows] = await connection.query<any[]>("SELECT COUNT(*) AS count FROM platform_background_jobs WHERE concurrency_key=? AND status='running'", [job.concurrency_key])
        if (Number(countRows[0]?.count ?? 0) >= job.concurrency_limit) continue
      }
      const [result] = await connection.query<any>("UPDATE platform_background_jobs SET status='running', attempts=attempts+1, locked_at=NOW(), worker_id=?, started_at=COALESCE(started_at, NOW()) WHERE id=? AND status='queued'", [executionId, job.id])
      if (Number(result.affectedRows) !== 1) continue
      job.status = "running"
      job.attempts += 1
      job.locked_at = new Date().toISOString()
      job.worker_id = executionId
      claimed.push(job)
      await connection.query("INSERT INTO platform_background_job_events (job_id, event_type, detail) VALUES (?,?,?)", [job.id, "running", JSON.stringify({ workerId, executionId, attempt: job.attempts })])
    }
    return claimed
  })
}

type JobHandlerContext = { signal: AbortSignal; job: BackgroundJob }
type JobHandler = (payload: BackgroundJobPayload, context: JobHandlerContext) => Promise<Record<string, unknown> | void>

const JOB_HANDLERS: Record<BackgroundJobType, JobHandler> = {
  async "email.send"(payload) {
    const email = payload as EmailPayload
    const { hydrateDepartmentSMTP, sendEmail } = await import("@/lib/email")
    if (email.department) await hydrateDepartmentSMTP(email.department)
    const result = await sendEmail(email)
    return { messageId: result.messageId ?? null, providerThreadId: result.providerThreadId ?? null }
  },
}

/** Row lock + attempt identity prevent stale workers from finishing another attempt. */
export function ownsJobAttempt(job: BackgroundJob, latest: BackgroundJob): boolean {
  return latest.status === "running" && latest.worker_id === job.worker_id && latest.attempts === job.attempts
}

async function settleBackgroundJob(job: BackgroundJob, result: Record<string, unknown> | void, errorMessage: string | null, uncertain = false): Promise<BackgroundJobStatus> {
  return withTransaction(async connection => {
    const [rows] = await connection.query<any[]>("SELECT * FROM platform_background_jobs WHERE id=? FOR UPDATE", [job.id])
    if (!rows[0]) return "failed"
    const latest = mapJob(rows[0])
    if (!ownsJobAttempt(job, latest)) return latest.status
    const status: BackgroundJobStatus = latest.cancel_requested ? "cancelled"
      : !errorMessage ? "completed"
      : uncertain || latest.attempts >= latest.max_attempts ? "dead_letter" : "queued"
    const delay = retryDelaySeconds(latest.attempts, latest.backoff_seconds)
    await connection.query(
      `UPDATE platform_background_jobs SET status=?, result=?, error_message=?, locked_at=NULL,
       worker_id=NULL, completed_at=IF(?='queued',NULL,NOW()),
       available_at=IF(?='queued',DATE_ADD(NOW(),INTERVAL ? SECOND),available_at) WHERE id=?`,
      [status, JSON.stringify(result ?? {}), errorMessage?.slice(0, 4000) ?? null, status, status, delay, job.id],
    )
    await connection.query("INSERT INTO platform_background_job_events (job_id, event_type, detail) VALUES (?,?,?)",
      [job.id, status === "queued" ? "retry_scheduled" : status, JSON.stringify({ attempt: job.attempts, executionId: job.worker_id, uncertain, delaySeconds: status === "queued" ? delay : null })])
    return status
  })
}
async function completeBackgroundJob(job: BackgroundJob, result: Record<string, unknown> | void) {
  return settleBackgroundJob(job, result, null)
}
async function failBackgroundJob(job: BackgroundJob, errorMessage: string, uncertain = false) {
  return settleBackgroundJob(job, undefined, errorMessage, uncertain)
}

async function executeBackgroundJob(job: BackgroundJob): Promise<BackgroundJobStatus> {
  const latest = await getBackgroundJob(job.id)
  if (!latest || !ownsJobAttempt(job, latest)) return latest?.status ?? "failed"
  if (latest.cancel_requested) return completeBackgroundJob(job, undefined)
  const controller = new AbortController()
  const handler = JOB_HANDLERS[job.job_type]
  const work = handler(job.payload, { signal: controller.signal, job })
  // Retain a catch handler for work that completes after the race times out.
  void work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`Job timed out after ${job.timeout_seconds} seconds`))
        }, job.timeout_seconds * 1000)
      }),
    ])
    return completeBackgroundJob(job, result)
  } catch (error) {
    return failBackgroundJob(job, error instanceof Error ? error.message : "Unknown background job failure", controller.signal.aborted)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, action: (item: T) => Promise<void>) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await action(item)
    }
  })
  await Promise.all(workers)
}

export async function runBackgroundQueueWorker(input: { limit?: number; workerId?: string } = {}) {
  await ensureBackgroundJobSchema()
  const recovered = await recoverExpiredJobs()
  // Do not acquire leases for jobs waiting behind this worker's local slots.
  const limit = bounded(input.limit, 5, 1, 5)
  const workerId = (input.workerId || `scheduler-${process.pid}-${crypto.randomUUID().slice(0, 8)}`).slice(0, 120)
  const jobs = await claimQueuedJobs(limit, workerId)
  const outcomes: Record<BackgroundJobStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, dead_letter: 0, cancelled: 0 }
  await runWithConcurrency(jobs, 5, async (job) => { outcomes[await executeBackgroundJob(job)]++ })
  return { recovered, claimed: jobs.length, outcomes }
}
