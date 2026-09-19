import type { BackgroundJob } from "@/lib/background-jobs"
// Shared by the existing queue console. Never serialize payloads, results,
// worker identities or idempotency keys (which can contain reset tokens).
export function backgroundJobView(job: BackgroundJob) {
  return {
    id: job.id, job_type: job.job_type, tenant_id: job.tenant_id, status: job.status,
    priority: job.priority, attempts: job.attempts, max_attempts: job.max_attempts,
    available_at: job.available_at, created_at: job.created_at,
    error_message: job.error_message ? "Execution failed. See job monitoring." : null,
    cancel_requested: job.cancel_requested,
  }
}
