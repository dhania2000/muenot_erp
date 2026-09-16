import "server-only"
import { query } from "@/lib/db"
import { normalizeStage, isTerminalStage, type CanonicalStage } from "@/lib/recruitment-stages"
import { logRecruitmentAudit } from "@/lib/recruit-audit"

/**
 * Phase 56 — Status sync.
 *
 * When one workflow record changes state, its dependent records must move with
 * it so the ONE unified pipeline never contradicts itself. This layer performs
 * the cross-record propagation for the operational spine
 * (recruit_applications / recruit_interviews / recruit_offers), the canonical
 * Candidate Master (recruitment_candidates) and the Requisition -> Job
 * headcount (recruitment_requisitions / recruit_jobs).
 *
 * Every write is best-effort and independently guarded: a missing table or
 * column (a not-yet-migrated database) or a single failed update must never
 * block or roll back the business change that triggered the sync. Callers wrap
 * the whole thing in try/catch too, so this can only ever *add* consistency.
 */

function isMissingSchema(err: any): boolean {
  const code = err?.code || err?.original?.code
  return code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR"
}

/** Run a write that may hit not-yet-migrated schema; swallow schema errors. */
async function safeRun(sql: string, params: any[] = []): Promise<void> {
  try {
    await query(sql, params)
  } catch (err) {
    if (!isMissingSchema(err)) console.error("[recruit-status-sync] write failed", err)
  }
}

async function safeRead<T = any[]>(sql: string, params: any[] = [], fallback: T = [] as unknown as T): Promise<T> {
  try {
    return await query<T>(sql, params)
  } catch (err) {
    if (isMissingSchema(err)) return fallback
    console.error("[recruit-status-sync] read failed", err)
    return fallback
  }
}

type Actor = { actorId?: number | null; actorName?: string | null }

/** Terminal stages that end candidacy negatively. */
const REJECT_STAGES = new Set<CanonicalStage>(["rejected", "withdrawn"])
/** Stages that represent a successful placement. */
const HIRED_STAGES = new Set<CanonicalStage>(["hired"])

/**
 * Propagate an application's stage change onto every dependent record.
 *
 *  - rejected/withdrawn  -> cancel open interviews, void live offers, mark the
 *                           Candidate Master Rejected/Withdrawn.
 *  - hired               -> accept the live offer, mark the Candidate Master
 *                           Hired, bump the linked Requisition headcount and
 *                           close the Job when it is fully staffed.
 *  - forward stages      -> keep the Candidate Master status in step.
 */
export async function syncApplicationStatus(opts: {
  applicationId: string
  stage: CanonicalStage | string
  actor?: Actor
}): Promise<void> {
  const applicationId = String(opts.applicationId || "").trim()
  if (!applicationId) return
  const stage = normalizeStage(opts.stage)
  const actor = opts.actor ?? {}

  const [app] = await safeRead<any[]>(
    `SELECT application_id, candidate_master_id, job_id, requisition_id, candidate_name
       FROM recruit_applications WHERE application_id = ? LIMIT 1`,
    [applicationId],
  )
  if (!app) return

  const candidateMasterId: string | null = app.candidate_master_id || null
  const jobId: string | null = app.job_id || null
  const requisitionId: string | null = app.requisition_id || null

  if (REJECT_STAGES.has(stage)) {
    // Open interviews for this application are no longer relevant.
    await safeRun(
      `UPDATE recruit_interviews SET status = 'cancelled'
         WHERE application_id = ? AND status IN ('scheduled','rescheduled','pending')`,
      [applicationId],
    )
    // A live (un-accepted) offer is voided.
    await safeRun(
      `UPDATE recruit_offers SET status = 'withdrawn'
         WHERE application_id = ? AND status IN ('draft','sent','pending')`,
      [applicationId],
    )
    if (candidateMasterId) {
      const masterStatus = stage === "withdrawn" ? "Withdrawn" : "Rejected"
      await safeRun(
        `UPDATE recruitment_candidates SET candidate_status = ? WHERE candidate_id = ?`,
        [masterStatus, candidateMasterId],
      )
    }
  } else if (HIRED_STAGES.has(stage)) {
    // The offer that led to the hire is accepted.
    await safeRun(
      `UPDATE recruit_offers SET status = 'accepted'
         WHERE application_id = ? AND status IN ('sent','offer_accepted','offer','pending','draft')`,
      [applicationId],
    )
    if (candidateMasterId) {
      await safeRun(
        `UPDATE recruitment_candidates SET candidate_status = 'Hired' WHERE candidate_id = ?`,
        [candidateMasterId],
      )
    }
    await bumpRequisitionHeadcount(requisitionId, jobId, actor)
  } else if (candidateMasterId) {
    // Forward progression — mirror the human-readable status onto the master so
    // the Candidate Master view never lags the operational pipeline.
    const label = stage
      .split("_")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ")
    await safeRun(
      `UPDATE recruitment_candidates SET candidate_status = ? WHERE candidate_id = ?`,
      [label, candidateMasterId],
    )
  }
}

/**
 * Increment the filled headcount on the linked Requisition and close the Job
 * once every position is filled. Recomputes pending_resources defensively and
 * clamps filled to the required count so a double-hire cannot overshoot.
 */
async function bumpRequisitionHeadcount(
  requisitionId: string | null,
  jobId: string | null,
  actor: Actor,
): Promise<void> {
  if (requisitionId) {
    const [req] = await safeRead<any[]>(
      `SELECT requisition_id, required_resources, filled_resources
         FROM recruitment_requisitions WHERE requisition_id = ? LIMIT 1`,
      [requisitionId],
    )
    if (req) {
      const required = Number(req.required_resources) || 0
      const filled = Math.min((Number(req.filled_resources) || 0) + 1, required || Number.MAX_SAFE_INTEGER)
      const pending = required > 0 ? Math.max(required - filled, 0) : 0
      await safeRun(
        `UPDATE recruitment_requisitions
            SET filled_resources = ?, pending_resources = ?
          WHERE requisition_id = ?`,
        [filled, pending, requisitionId],
      )
      if (required > 0 && filled >= required) {
        await safeRun(
          `UPDATE recruitment_requisitions SET status = 'closed'
             WHERE requisition_id = ? AND status <> 'closed'`,
          [requisitionId],
        )
      }
    }
  }

  if (jobId) {
    // Close the Job once its open positions are all filled by hired applications.
    const [job] = await safeRead<any[]>(
      `SELECT job_id, positions, status FROM recruit_jobs WHERE job_id = ? LIMIT 1`,
      [jobId],
    )
    if (job) {
      const positions = Number(job.positions) || 0
      const [{ hired = 0 } = {}] = await safeRead<any[]>(
        `SELECT COUNT(*) AS hired FROM recruit_applications
           WHERE job_id = ? AND stage IN ('hired','joined')`,
        [jobId],
      )
      if (positions > 0 && Number(hired) >= positions && job.status !== "closed") {
        await safeRun(`UPDATE recruit_jobs SET status = 'closed' WHERE job_id = ?`, [jobId])
      }
    }
  }
}

/**
 * Propagate an offer status change back onto its application and the Candidate
 * Master, so accepting/declining an offer keeps the pipeline consistent.
 *
 *  - accepted             -> application -> offer_accepted
 *  - declined/withdrawn   -> application -> rejected
 *  - expired              -> application falls back to selected (still in play)
 */
export async function syncOfferStatus(opts: {
  offerId: string
  status: string
  actor?: Actor
}): Promise<void> {
  const offerId = String(opts.offerId || "").trim()
  if (!offerId) return
  const status = String(opts.status || "").trim().toLowerCase()

  const [offer] = await safeRead<any[]>(
    `SELECT offer_id, application_id FROM recruit_offers WHERE offer_id = ? LIMIT 1`,
    [offerId],
  )
  const applicationId: string | null = offer?.application_id || null
  if (!applicationId) return

  let targetStage: CanonicalStage | null = null
  if (status === "accepted") targetStage = "offer_accepted"
  else if (status === "declined" || status === "rejected" || status === "withdrawn") targetStage = "rejected"
  else if (status === "expired") targetStage = "selected"
  if (!targetStage) return

  await safeRun(`UPDATE recruit_applications SET stage = ? WHERE application_id = ?`, [targetStage, applicationId])
  // Cascade the derived application stage onward (candidate master, etc.).
  await syncApplicationStatus({ applicationId, stage: targetStage, actor: opts.actor })
}

/**
 * Propagate an interview status change onto its application. Only the outcome
 * states move the pipeline; scheduling/rescheduling is handled by the calendar
 * sync and does not change the canonical application stage here.
 */
export async function syncInterviewStatus(opts: {
  interviewId: string
  status: string
  actor?: Actor
}): Promise<void> {
  const interviewId = String(opts.interviewId || "").trim()
  if (!interviewId) return
  const status = String(opts.status || "").trim().toLowerCase()

  const [interview] = await safeRead<any[]>(
    `SELECT interview_id, application_id FROM recruit_interviews WHERE interview_id = ? LIMIT 1`,
    [interviewId],
  )
  const applicationId: string | null = interview?.application_id || null
  if (!applicationId) return

  let targetStage: CanonicalStage | null = null
  if (status === "selected" || status === "passed" || status === "cleared") targetStage = "selected"
  else if (status === "rejected" || status === "failed") targetStage = "rejected"
  if (!targetStage) return

  await safeRun(`UPDATE recruit_applications SET stage = ? WHERE application_id = ?`, [targetStage, applicationId])
  await syncApplicationStatus({ applicationId, stage: targetStage, actor: opts.actor })
}

/**
 * Shared helper: record a status-sync driven change on the recruitment audit
 * trail. Best-effort; callers already log their own primary action.
 */
export async function logStatusSyncAudit(entry: {
  module: string
  table: string
  recordId: string
  action: "update"
  actor?: Actor
  oldValue?: Record<string, any>
  newValue?: Record<string, any>
}): Promise<void> {
  try {
    await logRecruitmentAudit({
      module: entry.module,
      table: entry.table,
      recordId: entry.recordId,
      action: entry.action,
      userId: entry.actor?.actorId ?? null,
      userName: entry.actor?.actorName ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
    })
  } catch {
    // never block on audit
  }
}

/** Terminal-stage predicate re-export so callers need not import two modules. */
export function isTerminal(stage: CanonicalStage | string): boolean {
  return isTerminalStage(normalizeStage(stage))
}
