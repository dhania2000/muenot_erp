import "server-only"

import { withTransaction } from "@/lib/db"
import { TenantJobError } from "@/lib/tenant-jobs/model"
import type { TenantJob } from "@/lib/tenant-jobs/store"

/**
 * Reviewed action registry. This is the ONLY code a tenant schedule can run;
 * each handler re-validates its stored params against the tenant's own data.
 */
export async function runTenantJobAction(job: TenantJob, runId: number): Promise<Record<string, unknown>> {
  const params = job.actionParams as Record<string, unknown>
  if (job.actionKey === "notification.reminder") {
    const { enqueueNotification } = await import("@/lib/notification-engine/service")
    const deliveryId = await withTransaction((c) => enqueueNotification(c, {
      tenantId: job.tenantId,
      userId: job.ownerUserId,
      channel: "in_app",
      key: `tenant-job:${runId}`,
      title: String(params.title).slice(0, 255),
      body: String(params.body ?? ""),
      link: "/admin/scheduled-jobs",
      context: { action: "tenant_job.reminder", entityTable: "tenant_scheduled_jobs", entityId: String(job.id) },
    }))
    return { deliveryId }
  }
  if (job.actionKey === "data_export.run") {
    const { createAndRunExport } = await import("@/lib/data-export-store")
    let exportJob
    try {
      exportJob = await createAndRunExport(job.tenantId, { datasetKey: String(params.datasetKey), format: params.format, triggerSource: "scheduler" }, { userId: job.ownerUserId, role: "tenant_admin" })
    } catch (error) {
      if (error instanceof Error && /unknown export dataset/i.test(error.message)) throw new TenantJobError("The export dataset no longer exists")
      throw error
    }
    if (exportJob.status === "failed") throw new TenantJobError(exportJob.error ?? "Export failed", "transient")
    return { exportJobId: exportJob.id, rowCount: exportJob.rowCount, fileName: exportJob.fileName }
  }
  if (job.actionKey === "report_schedule.deliver") {
    const { getReportSchedule, executeReportSchedule } = await import("@/lib/reports/scheduler-store")
    const schedule = await getReportSchedule(job.tenantId, Number(params.reportScheduleId))
    if (!schedule) throw new TenantJobError("The report schedule no longer exists")
    const outcome = await executeReportSchedule(schedule, { triggerSource: "scheduler" })
    // Delivery may have partially happened: dead-letter for a reviewed retry.
    if (outcome.status === "failed") throw new TenantJobError(outcome.error ?? "Report delivery failed")
    return { reportRunId: outcome.runId, status: outcome.status }
  }
  throw new TenantJobError("This action is no longer available")
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
}

/** In-app notice to the owner plus optional queued emails. Idempotent per run+outcome. */
export async function notifyTenantJobOutcome(job: TenantJob, runId: number, outcome: "succeeded" | "failed" | "dead_letter", errorMessage: string | null) {
  const failed = outcome !== "succeeded"
  const title = failed ? `Scheduled job failed: ${job.name}` : `Scheduled job succeeded: ${job.name}`
  const body = failed ? (errorMessage ?? "Unknown error").slice(0, 500) : "The scheduled job completed successfully."
  const { enqueueNotification } = await import("@/lib/notification-engine/service")
  await withTransaction((c) => enqueueNotification(c, {
    tenantId: job.tenantId,
    userId: job.ownerUserId,
    channel: "in_app",
    key: `tenant-job-outcome:${runId}:${outcome}`,
    title: title.slice(0, 255),
    body,
    link: "/admin/scheduled-jobs",
    priority: failed ? 10 : 5,
  })).catch((error) => console.error("[tenant-jobs] in-app outcome notice failed", error instanceof Error ? error.message : error))
  if (!job.notifyEmails.length) return
  const { enqueueEmailJob } = await import("@/lib/background-jobs")
  for (const to of job.notifyEmails) {
    await enqueueEmailJob({
      triggerSource: "scheduler",
      tenantId: job.tenantId,
      payload: { to, subject: `Muenot: ${title}`.slice(0, 255), html: `<p>${escapeHtml(title)}</p><p>${escapeHtml(body)}</p>` },
      priority: failed ? 8 : 4,
      maxAttempts: 3,
      concurrencyKey: `tenant-scheduled-notify:${job.tenantId}`,
      concurrencyLimit: 2,
      idempotencyKey: `tenant-job-outcome:${runId}:${outcome}:${to}`,
    }).catch((error) => console.error("[tenant-jobs] outcome email queueing failed", error instanceof Error ? error.message : error))
  }
}
