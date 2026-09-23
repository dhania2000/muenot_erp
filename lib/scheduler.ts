import "server-only"
import { classifyJobFailure } from "@/lib/job-retry-policy"

import {
  claimCronRun,
  finishCronRun,
  isCronConfigDue,
  listCronJobs,
  updateCronRunAttempt,
  type CronJobConfig,
} from "@/lib/cron-jobs"

/**
 * SPEC 41 — Central scheduler abstraction.
 *
 * The cron configuration and persistence primitives remain in cron-jobs.ts,
 * while this module owns the platform-level execution contract: categorising
 * jobs, selecting due work, invoking only reviewed internal endpoints, and
 * reporting the outcome.
 */
export const SCHEDULER_CATEGORIES = [
  "reports",
  "notifications",
  "billing",
  "data_sync",
  "storage_cleanup",
  "payroll",
  "gst_tds",
  "email_campaigns",
  "integrations",
  "ai_tasks",
] as const

export type SchedulerCategory = (typeof SCHEDULER_CATEGORIES)[number]

export const SCHEDULER_CATEGORY_LABELS: Record<SchedulerCategory, string> = {
  reports: "Reports",
  notifications: "Notifications",
  billing: "Billing",
  data_sync: "Data sync",
  storage_cleanup: "Storage cleanup",
  payroll: "Payroll",
  gst_tds: "GST / TDS",
  email_campaigns: "Email campaigns",
  integrations: "Integrations",
  ai_tasks: "AI tasks",
}

const CATEGORY_BY_JOB: Record<string, SchedulerCategory> = {
  operations_monitoring: "reports",
  notice_board: "notifications",
  knowledge_base: "notifications",
  call_cleanup: "notifications",
  recruit_reminders: "notifications",
  employee_asset_reminders: "notifications",
  payment_reminders: "billing",
  provisions_periodic: "billing",
  fixed_assets_depreciation: "billing",
  loan_reminders: "billing",
  investment_reminders: "billing",
  related_party_scan: "billing",
  subscription_reminders: "billing",
  subscription_lifecycle: "billing",
  calendar_sync: "data_sync",
  backups: "data_sync",
  storage_retention: "storage_cleanup",
  monitor_retention: "storage_cleanup",
  audit_retention: "storage_cleanup",
  data_retention: "storage_cleanup",
  data_export: "data_sync",
  temporary_access: "notifications",
  api_rate_limit_cleanup: "storage_cleanup",
  marketing_library: "storage_cleanup",
  gst_daily: "gst_tds",
  gst_monthly: "gst_tds",
  tds_daily: "gst_tds",
  tds_monthly: "gst_tds",
  tds_quarterly: "gst_tds",
  sales_emails: "email_campaigns",
  finance_emails: "email_campaigns",
  marketing_journeys: "email_campaigns",
  marketing_planner: "email_campaigns",
  contracts: "integrations",
  esign_scheduler: "integrations",
  whatsapp_scheduler: "integrations",
  background_queue: "integrations",
  workflow_worker: "integrations",
  business_events: "integrations",
  notification_delivery: "notifications",
}

export function getSchedulerCategory(jobKey: string): SchedulerCategory | null {
  return CATEGORY_BY_JOB[jobKey] ?? null
}

export type SchedulerJob = CronJobConfig & { category: SchedulerCategory }

export async function listSchedulerJobs(): Promise<SchedulerJob[]> {
  const jobs = await listCronJobs()
  return jobs.flatMap((job) => {
    const category = getSchedulerCategory(job.key)
    return category ? [{ ...job, category }] : []
  })
}

export type SchedulerInventoryItem = {
  category: SchedulerCategory
  label: string
  jobs: SchedulerJob[]
  configured: boolean
}

/** Return every supported category, including future-ready empty categories. */
export async function listSchedulerInventory(): Promise<SchedulerInventoryItem[]> {
  const jobs = await listSchedulerJobs()
  return SCHEDULER_CATEGORIES.map((category) => ({
    category,
    label: SCHEDULER_CATEGORY_LABELS[category],
    jobs: jobs.filter((job) => job.category === category),
    configured: jobs.some((job) => job.category === category),
  }))
}

type SchedulerRequest = { url: string }
type JobResult = {
  key: string
  category: SchedulerCategory
  status: "succeeded" | "failed" | "skipped"
  error?: string | null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
}

async function notifyFailure(job: SchedulerJob, scheduledFor: string, attempts: number, errorMessage: string | null) {
  if (!job.notify_on_failure) return
  try {
    const { recordActivity } = await import("@/lib/notifications")
    await recordActivity({
      action: "update",
      title: `Scheduled job failed: ${job.name}`,
      body: `${errorMessage ?? "Unknown error"} (${attempts} attempt(s))`,
      link: "/platform/scheduler",
    })
    if (job.notification_emails) {
      const { enqueueEmailJob } = await import("@/lib/background-jobs")
      const safeError = escapeHtml(errorMessage ?? "Unknown error")
      for (const to of job.notification_emails.split(",").map((email) => email.trim()).filter(Boolean)) {
        await enqueueEmailJob({
          triggerSource: "scheduler",
          payload: {
            to,
            subject: `Muenot scheduled job failed: ${job.name}`,
            html: `<p>The scheduled job <strong>${escapeHtml(job.name)}</strong> failed after ${attempts} attempt(s).</p><p>${safeError}</p>`,
          },
          priority: 9,
          maxAttempts: 3,
          backoffSeconds: 30,
          concurrencyKey: "scheduler-failure-email",
          concurrencyLimit: 2,
          idempotencyKey: `scheduler-failure:${job.key}:${scheduledFor}:${to}`,
        }).catch((error) => console.error("[scheduler] failure email queueing failed", error))
      }
    }
  } catch (error) {
    console.error("[scheduler] failure notification failed", error)
  }
}

async function executeScheduledJob(job: SchedulerJob, request: SchedulerRequest): Promise<JobResult> {
  const claim = await claimCronRun(job)
  if (!claim) return { key: job.key, category: job.category, status: "skipped" }

  const startedAt = Date.now()
  let lastError: string | null = null
  const attempts = job.retry_limit + 1
  let performed = 0
  for (let attempt = 1; attempt <= attempts; attempt++) {
    performed = attempt
    await updateCronRunAttempt(claim.id, attempt)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), job.timeout_seconds * 1000)
      try {
        const base = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
        const headers: HeadersInit = { "cache-control": "no-store", "x-muenot-cron-dispatcher": "1" }
        if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`
        const response = await fetch(new URL(job.endpoint, base), {
          method: "GET",
          headers,
          signal: controller.signal,
          cache: "no-store",
        })
        if (!response.ok) throw Object.assign(new Error(`Job endpoint returned HTTP ${response.status}`), { status: response.status })
      } finally {
        clearTimeout(timer)
      }
      await finishCronRun(claim.id, "succeeded", startedAt, null)
      return { key: job.key, category: job.category, status: "succeeded" }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown job error"
      if (classifyJobFailure(error) !== "transient") break
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** (attempt - 1))))
    }
  }

  await finishCronRun(claim.id, "failed", startedAt, lastError)
  console.error(`[scheduler] ${job.key} failed after ${performed} attempt(s): ${lastError}`)
  await notifyFailure(job, claim.scheduledFor, performed, lastError)
  return { key: job.key, category: job.category, status: "failed", error: lastError }
}

export async function runSchedulerTick(request: SchedulerRequest, category?: SchedulerCategory) {
  const allJobs = await listSchedulerJobs()
  const jobs = allJobs.filter((job) => (!category || job.category === category) && isCronConfigDue(job))
  const results: JobResult[] = []
  for (const job of jobs) results.push(await executeScheduledJob(job, request))
  const byCategory = SCHEDULER_CATEGORIES.reduce<Record<SchedulerCategory, number>>((counts, name) => {
    counts[name] = results.filter((result) => result.category === name).length
    return counts
  }, {} as Record<SchedulerCategory, number>)
  return { considered: jobs.length, results, byCategory }
}
