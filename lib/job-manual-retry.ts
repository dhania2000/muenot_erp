import "server-only"
import { withTransaction, query } from "@/lib/db"
import { ensureBackgroundJobSchema } from "@/lib/background-jobs"

export class RetryConflict extends Error {}
export async function retryDeadLetter(id: number, expectedAttempt: number, actorId: number, acknowledgeUncertain: boolean) {
  await ensureBackgroundJobSchema()
  return withTransaction(async connection => {
    const [rows] = await connection.query<any[]>("SELECT id, status, attempts, result FROM platform_background_jobs WHERE id=? FOR UPDATE", [id])
    const job = rows[0]
    if (!job || !["failed", "dead_letter"].includes(job.status) || Number(job.attempts) !== expectedAttempt) throw new RetryConflict("Job changed. Refresh before retrying.")
    const result = typeof job.result === "string" ? JSON.parse(job.result) : job.result
    // Legacy jobs have unknown delivery outcomes too.
    const uncertain = !result?.failureKind || result.failureKind === "uncertain"
    if (uncertain && !acknowledgeUncertain) throw new RetryConflict("Confirm that you checked the delivery outcome before retrying.")
    if (expectedAttempt >= 254) throw new RetryConflict("Lifetime attempt limit reached.")
    // Authorize exactly one additional attempt. Preserve history and identity.
    await connection.query(`UPDATE platform_background_jobs SET status='queued', max_attempts=attempts+1,
      available_at=NOW(), completed_at=NULL, locked_at=NULL, worker_id=NULL, cancel_requested=0 WHERE id=?`, [id])
    await connection.query("INSERT INTO platform_background_job_events (job_id,event_type,detail) VALUES (?,?,?)",
      [id, "manual_retry", JSON.stringify({ actorId, expectedAttempt, acknowledgeUncertain })])
    return { id, status: "queued" }
  })
}

/** Durable in-app failure notifications; no message bodies or provider errors. */
export async function listJobFailureNotices() {
  await ensureBackgroundJobSchema()
  return query<{ id: number; job_id: number; created_at: string }[]>(`SELECT e.id, e.job_id, e.created_at
    FROM platform_background_job_events e JOIN platform_background_jobs j ON j.id=e.job_id
    WHERE e.event_type='dead_letter' AND j.status='dead_letter'
    ORDER BY e.id DESC LIMIT 20`)
}
