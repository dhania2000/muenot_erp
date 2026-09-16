import "server-only"
import { query } from "@/lib/db"
import { ensureLeadLifecycleSchema, notify } from "@/lib/sales/lead-lifecycle"
import { getWorkflowDays } from "@/lib/recruit-settings"

/**
 * Phases 66-68 — Stale recruitment detection.
 *
 * Scans the ONE unified recruitment spine for work that has gone quiet and
 * surfaces it (dashboard + report via getStaleSummary) and, on the scheduled
 * sweep, pings the responsible recruiter/hiring manager (runStaleDetection):
 *
 *   * Phase 66 — Stale Applications: an application sitting in the same
 *     non-terminal stage longer than the configured number of days. We NEVER
 *     auto-reject a candidate (the spec is explicit); we only flag + notify.
 *
 *   * Phase 67 — Stale Requisitions: a requisition past its target date that
 *     still has pending (unfilled) resources — reported with Days Open,
 *     Required, Filled and Pending.
 *
 *   * Phase 68 — Stale Jobs: an open job with no recent application activity.
 *
 * Idempotency (Phase 65): notifications are claimed against the shared
 * `recruitment_reminder_log` table using a dedupe key that includes an ISO-week
 * bucket, so a genuinely-stuck record pings its owner at most once per week —
 * running the cron many times a day never produces duplicate notifications.
 *
 * Thresholds are configurable (Phase 66/67/68 "configured days") from the
 * Recruitment Settings module (`recruitment_settings.setting_name` /
 * `setting_value`); sensible defaults apply when unset. Every read degrades
 * gracefully on a not-yet-migrated database.
 */

// Applications parked in one of these stages are closed and never "stale".
const CLOSED_APP_STAGES = ["hired", "rejected", "hold", "withdrawn"]
// Requisitions in one of these states are done and never "stale".
const CLOSED_REQ_STATUSES = ["closed", "filled", "cancelled", "rejected", "completed", "on hold"]

export type StaleThresholds = {
  applicationDays: number
  requisitionGraceDays: number
  jobDays: number
}

async function safeRows(sql: string, params: any[] = []): Promise<any[]> {
  try {
    return (await query(sql, params)) as any[]
  } catch {
    // Table not migrated yet on a fresh install — nothing to scan.
    return []
  }
}

/**
 * Read the configurable stale thresholds. Phase 96: delegates to the single
 * Recruitment Settings source of truth (`lib/recruit-settings`) instead of
 * re-reading the settings table with its own defaults.
 */
export async function getStaleThresholds(): Promise<StaleThresholds> {
  const wd = await getWorkflowDays()
  return {
    applicationDays: wd.staleApplicationDays,
    requisitionGraceDays: wd.staleRequisitionGraceDays,
    jobDays: wd.staleJobDays,
  }
}

/* -------------------------------------------------------------------------- */
/* Read side — dashboard / report                                             */
/* -------------------------------------------------------------------------- */

export type StaleApplication = {
  application_id: string
  candidate_name: string | null
  job_title: string | null
  stage: string
  recruiter: string | null
  days_in_stage: number
}

export type StaleRequisition = {
  requisition_id: string
  job_title: string | null
  recruiter: string | null
  hiring_manager: string | null
  target_date: string | null
  days_open: number
  required: number
  filled: number
  pending: number
}

export type StaleJob = {
  job_id: string
  title: string
  recruiter: string | null
  last_application_at: string | null
  days_since_activity: number
}

export type StaleSummary = {
  thresholds: StaleThresholds
  applications: { total: number; items: StaleApplication[] }
  requisitions: { total: number; items: StaleRequisition[] }
  jobs: { total: number; items: StaleJob[] }
}

const closedAppList = CLOSED_APP_STAGES.map((s) => `'${s}'`).join(",")
const closedReqList = CLOSED_REQ_STATUSES.map((s) => `'${s}'`).join(",")

async function scanStaleApplications(days: number, limit = 200): Promise<StaleApplication[]> {
  const rows = await safeRows(
    `SELECT application_id, candidate_name, job_title, stage, recruiter,
            DATEDIFF(NOW(), updated_at) AS days_in_stage
       FROM recruit_applications
      WHERE LOWER(stage) NOT IN (${closedAppList})
        AND updated_at IS NOT NULL
        AND updated_at < (NOW() - INTERVAL ? DAY)
      ORDER BY updated_at ASC
      LIMIT ?`,
    [days, limit],
  )
  return rows.map((r) => ({
    application_id: String(r.application_id),
    candidate_name: r.candidate_name ?? null,
    job_title: r.job_title ?? null,
    stage: String(r.stage),
    recruiter: r.recruiter ?? null,
    days_in_stage: Number(r.days_in_stage ?? 0),
  }))
}

async function scanStaleRequisitions(graceDays: number, limit = 200): Promise<StaleRequisition[]> {
  const rows = await safeRows(
    `SELECT requisition_id, job_title, recruiter, hiring_manager, target_date, requisition_date,
            COALESCE(required_resources, 0) AS required_resources,
            COALESCE(filled_resources, 0) AS filled_resources,
            COALESCE(pending_resources, GREATEST(COALESCE(required_resources,0) - COALESCE(filled_resources,0), 0)) AS pending_resources,
            DATEDIFF(NOW(), COALESCE(requisition_date, target_date)) AS days_open
       FROM recruitment_requisitions
      WHERE LOWER(COALESCE(status,'')) NOT IN (${closedReqList})
        AND target_date IS NOT NULL
        AND target_date < (CURDATE() - INTERVAL ? DAY)
        AND COALESCE(pending_resources, GREATEST(COALESCE(required_resources,0) - COALESCE(filled_resources,0), 0)) > 0
      ORDER BY target_date ASC
      LIMIT ?`,
    [graceDays, limit],
  )
  return rows.map((r) => ({
    requisition_id: String(r.requisition_id),
    job_title: r.job_title ?? null,
    recruiter: r.recruiter ?? null,
    hiring_manager: r.hiring_manager ?? null,
    target_date: r.target_date ? String(r.target_date).slice(0, 10) : null,
    days_open: Math.max(Number(r.days_open ?? 0), 0),
    required: Number(r.required_resources ?? 0),
    filled: Number(r.filled_resources ?? 0),
    pending: Number(r.pending_resources ?? 0),
  }))
}

async function scanStaleJobs(days: number, limit = 200): Promise<StaleJob[]> {
  // Open jobs whose most recent application (or, with no applications, whose own
  // creation) is older than the configured window. Brand-new jobs (created
  // within the window) are never flagged.
  const rows = await safeRows(
    `SELECT j.job_id, j.title, j.recruiter,
            MAX(a.applied_at) AS last_application_at,
            DATEDIFF(NOW(), COALESCE(MAX(a.applied_at), j.created_at)) AS days_since_activity
       FROM recruit_jobs j
       LEFT JOIN recruit_applications a ON a.job_id = j.job_id
      WHERE LOWER(j.status) = 'open'
        AND j.created_at < (NOW() - INTERVAL ? DAY)
      GROUP BY j.id
      HAVING days_since_activity >= ?
      ORDER BY days_since_activity DESC
      LIMIT ?`,
    [days, days, limit],
  )
  return rows.map((r) => ({
    job_id: String(r.job_id),
    title: String(r.title),
    recruiter: r.recruiter ?? null,
    last_application_at: r.last_application_at ? String(r.last_application_at) : null,
    days_since_activity: Number(r.days_since_activity ?? 0),
  }))
}

/**
 * Build the stale summary for the dashboard / report. Read-only and
 * failure-tolerant: a missing table yields an empty bucket, never a throw.
 */
export async function getStaleSummary(previewLimit = 8): Promise<StaleSummary> {
  const thresholds = await getStaleThresholds()
  const [apps, reqs, jobs] = await Promise.all([
    scanStaleApplications(thresholds.applicationDays),
    scanStaleRequisitions(thresholds.requisitionGraceDays),
    scanStaleJobs(thresholds.jobDays),
  ])
  return {
    thresholds,
    applications: { total: apps.length, items: apps.slice(0, previewLimit) },
    requisitions: { total: reqs.length, items: reqs.slice(0, previewLimit) },
    jobs: { total: jobs.length, items: jobs.slice(0, previewLimit) },
  }
}

/* -------------------------------------------------------------------------- */
/* Notify side — scheduled sweep                                              */
/* -------------------------------------------------------------------------- */

/** ISO-week bucket ("2026-W38") so a stuck record notifies at most once a week. */
function isoWeekBucket(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

let logEnsured = false
async function ensureReminderLog(): Promise<void> {
  if (logEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS recruitment_reminder_log (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      dedupe_key VARCHAR(190) NOT NULL,
      event_key VARCHAR(60) NOT NULL,
      source_module VARCHAR(60) DEFAULT NULL,
      source_ref VARCHAR(80) DEFAULT NULL,
      to_email VARCHAR(190) DEFAULT NULL,
      email_status VARCHAR(20) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_recruit_reminder (dedupe_key),
      KEY idx_recruit_reminder_ref (source_module, source_ref)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ).catch(() => {})
  logEnsured = true
}

/** Atomically claim a dedupe key — only the first caller in the window wins. */
async function claim(dedupeKey: string, event: string, sourceModule: string, sourceRef: string): Promise<boolean> {
  try {
    const res = (await query(
      `INSERT IGNORE INTO recruitment_reminder_log (dedupe_key, event_key, source_module, source_ref, email_status)
       VALUES (?, ?, ?, ?, 'Notified')`,
      [dedupeKey, event, sourceModule, sourceRef],
    )) as any
    return Number(res?.affectedRows ?? 0) > 0
  } catch {
    return false
  }
}

/** Resolve a recruiter/manager name (or email) to an internal user id for in-app notifications. */
async function resolveUserId(name: string | null | undefined): Promise<number | null> {
  const n = String(name ?? "").trim()
  if (!n) return null
  try {
    const direct = (await query(
      "SELECT id FROM users WHERE LOWER(name) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1",
      [n, n],
    )) as any[]
    if (direct[0]?.id) return Number(direct[0].id)
  } catch {
    // users table shape differs — fall through to the HR lookup.
  }
  try {
    const emp = (await query(
      `SELECT COALESCE(NULLIF(official_email,''), personal_email) AS email
         FROM hr_employees WHERE employee_name = ? OR employee_id = ? LIMIT 1`,
      [n, n],
    )) as any[]
    const email = String(emp[0]?.email ?? "").trim()
    if (!email) return null
    const u = (await query("SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1", [email])) as any[]
    return u[0]?.id ? Number(u[0].id) : null
  } catch {
    return null
  }
}

export type StaleDetectionResult = {
  staleApplications: number
  staleRequisitions: number
  staleJobs: number
  notified: number
}

/**
 * Scheduled stale sweep. Flags nothing destructively (never auto-rejects) — it
 * only creates de-duplicated in-app notifications for the owning recruiter /
 * hiring manager and returns the counts for the cron response.
 */
export async function runStaleDetection(): Promise<StaleDetectionResult> {
  await ensureReminderLog()
  try {
    await ensureLeadLifecycleSchema()
  } catch {
    // notify() is itself best-effort; continue regardless.
  }

  const thresholds = await getStaleThresholds()
  const week = isoWeekBucket()
  const result: StaleDetectionResult = {
    staleApplications: 0,
    staleRequisitions: 0,
    staleJobs: 0,
    notified: 0,
  }

  const ping = async (
    event: string,
    sourceModule: string,
    sourceRef: string,
    ownerName: string | null,
    payload: { title: string; body: string; link: string; entityType: string },
  ) => {
    const claimed = await claim(`${event}:${sourceRef}:${week}`, event, sourceModule, sourceRef)
    if (!claimed) return
    const userId = await resolveUserId(ownerName)
    if (!userId) return
    await notify(null, {
      userId,
      type: "warning",
      title: payload.title,
      body: payload.body,
      link: payload.link,
      entityType: payload.entityType,
      entityId: sourceRef,
    }).catch(() => {})
    result.notified += 1
  }

  // Phase 66 — Stale applications.
  const apps = await scanStaleApplications(thresholds.applicationDays)
  result.staleApplications = apps.length
  for (const a of apps) {
    await ping("stale_application", "recruit_applications", a.application_id, a.recruiter, {
      title: `Stale application: ${a.candidate_name || a.application_id}`,
      body: `${a.candidate_name || "This candidate"} has been in the "${a.stage}" stage for ${a.days_in_stage} days${a.job_title ? ` for ${a.job_title}` : ""}. Please review and progress or close it.`,
      link: "/modules/recruitment/job-applications",
      entityType: "recruitment_application",
    })
  }

  // Phase 67 — Stale requisitions.
  const reqs = await scanStaleRequisitions(thresholds.requisitionGraceDays)
  result.staleRequisitions = reqs.length
  for (const r of reqs) {
    const owner = r.recruiter || r.hiring_manager
    await ping("stale_requisition", "recruitment_requisitions", r.requisition_id, owner, {
      title: `Requisition past target date: ${r.job_title || r.requisition_id}`,
      body: `Open ${r.days_open} days · Required ${r.required} · Filled ${r.filled} · Pending ${r.pending}. Target date ${r.target_date || "—"} has passed with positions still to fill.`,
      link: "/modules/recruitment/requisition-hiring",
      entityType: "recruitment_requisition",
    })
  }

  // Phase 68 — Stale jobs.
  const jobs = await scanStaleJobs(thresholds.jobDays)
  result.staleJobs = jobs.length
  for (const j of jobs) {
    await ping("stale_job", "recruit_jobs", j.job_id, j.recruiter, {
      title: `Stale job posting: ${j.title}`,
      body: `No application activity for ${j.days_since_activity} days on "${j.title}". Review the posting, refresh sourcing, or close it if the role is filled.`,
      link: "/modules/recruitment/jobs",
      entityType: "recruitment_job",
    })
  }

  return result
}
