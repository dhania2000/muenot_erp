import "server-only"
import { query } from "@/lib/db"

/**
 * Phase 42/43 — Recruitment task automation.
 *
 * Phase 42 wires the Recruitment Tasks module onto the ONE candidate spine:
 * every task carries candidate_id / application_id / job_title / requisition_id
 * so a task always points at a real record (Candidate Database, Application, Job
 * or Requisition), never a detached free-text note.
 *
 * Phase 43 auto-creates the follow-on task a workflow step implies:
 *   - Interview scheduled          -> "Submit interview feedback"
 *   - Offer / selection made       -> "Follow up on offer acceptance"
 *   - Background verification start -> "Complete background verification"
 *   - Joining date approaching     -> "Confirm joining"
 *
 * Every auto task uses a DETERMINISTIC business id derived from its source
 * record (e.g. AUTOFBK-<interview_id>) and is written with INSERT ... ON
 * DUPLICATE KEY UPDATE against the task_id unique key, so re-saving the source
 * record never spawns a duplicate task and never re-opens a task the recruiter
 * has already completed. Best-effort throughout: a failure here must never block
 * the primary recruitment write.
 */

function toDateOnly(v: any): string | null {
  if (!v) return null
  const d = new Date(v)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/** Return a YYYY-MM-DD offset from `base` by `days` (base defaults to today). */
function addDays(base: any, days: number): string | null {
  const d = base ? new Date(base) : new Date()
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function isBlank(v: any): boolean {
  return v === null || v === undefined || String(v).trim() === ""
}

type AutoTask = {
  task_id: string
  task_title: string
  task_type: string
  due_date: string | null
  candidate_id?: any
  candidate_name?: any
  job_title?: any
  requisition_id?: any
  application_id?: any
  priority?: string
  description?: string
}

/**
 * Idempotently create (or refresh the metadata of) an automated task. Never
 * touches `status`, so a completed/cancelled task stays that way on re-runs.
 */
async function upsertAutoTask(t: AutoTask, userId: number | null): Promise<void> {
  const { ensureRecruitmentModuleTable } = await import("@/lib/recruitment-crud")
  await ensureRecruitmentModuleTable("recruitment-tasks")

  await query(
    `INSERT INTO recruitment_tasks
       (task_id, task_title, task_type, priority, candidate_id, candidate_name,
        job_title, requisition_id, application_id, due_date, status, description, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       task_title      = VALUES(task_title),
       task_type       = VALUES(task_type),
       due_date        = VALUES(due_date),
       candidate_id    = COALESCE(recruitment_tasks.candidate_id, VALUES(candidate_id)),
       candidate_name  = COALESCE(recruitment_tasks.candidate_name, VALUES(candidate_name)),
       job_title       = COALESCE(recruitment_tasks.job_title, VALUES(job_title)),
       requisition_id  = COALESCE(recruitment_tasks.requisition_id, VALUES(requisition_id)),
       application_id  = COALESCE(recruitment_tasks.application_id, VALUES(application_id)),
       description     = VALUES(description)`,
    [
      t.task_id,
      t.task_title,
      t.task_type,
      t.priority || "Medium",
      t.candidate_id ?? null,
      t.candidate_name ?? null,
      t.job_title ?? null,
      t.requisition_id ?? null,
      t.application_id ?? null,
      t.due_date,
      "Pending",
      t.description ?? null,
      userId ?? null,
    ],
  )
}

const DONE_INTERVIEW = new Set(["selected", "rejected", "on hold", "no show", "cancelled"])
const DONE_OFFER = new Set(["accepted", "declined", "rejected", "withdrawn", "joined"])
const DONE_BGV = new Set(["completed", "verified", "clear", "cleared", "closed", "passed", "failed"])
const DONE_JOIN = new Set(["joined", "cancelled", "dropped", "withdrawn"])

/**
 * Inspect a just-saved config-driven stage record and create the task its
 * workflow step implies. Only the stage tables below produce a task; everything
 * else is a no-op.
 */
export async function autoCreateTasksForModule(
  table: string,
  record: Record<string, any>,
  userId: number | null,
): Promise<void> {
  const links = {
    candidate_id: record.candidate_id,
    candidate_name: record.candidate_name,
    job_title: record.job_title || record.job_applied,
    requisition_id: record.requisition_id,
    application_id: record.application_id,
  }
  const who = record.candidate_name ? ` — ${record.candidate_name}` : ""

  switch (table) {
    case "recruitment_interviews": {
      const iid = record.interview_id ? String(record.interview_id) : null
      if (!iid) return
      // Feedback is only outstanding until the interview has a result.
      if (!isBlank(record.interview_result) && DONE_INTERVIEW.has(String(record.interview_result).toLowerCase())) return
      await upsertAutoTask(
        {
          task_id: `AUTOFBK-${iid}`,
          task_title: `Submit interview feedback${who}`,
          task_type: "Interview",
          priority: "High",
          due_date: addDays(record.interview_date, 1) || addDays(null, 1),
          description: `Auto-created from interview ${iid}. Capture the panel feedback and outcome.`,
          ...links,
        },
        userId,
      )
      break
    }
    case "recruitment_selections": {
      const sid = record.selection_id ? String(record.selection_id) : null
      if (!sid) return
      const status = String(record.offer_status || record.joining_status || "").toLowerCase()
      if (status && DONE_OFFER.has(status)) return
      await upsertAutoTask(
        {
          task_id: `AUTOOFR-${sid}`,
          task_title: `Follow up on offer acceptance${who}`,
          task_type: "Offer",
          priority: "High",
          due_date: addDays(record.offer_date || record.selection_date, 3) || addDays(null, 3),
          description: `Auto-created from selection ${sid}. Confirm the candidate has accepted the offer.`,
          ...links,
        },
        userId,
      )
      break
    }
    case "recruitment_background_verification": {
      const bid = record.bgv_id ? String(record.bgv_id) : null
      if (!bid) return
      const status = String(record.result || record.status || "").toLowerCase()
      if (status && DONE_BGV.has(status)) return
      await upsertAutoTask(
        {
          task_id: `AUTOBGV-${bid}`,
          task_title: `Complete background verification${who}`,
          task_type: "BGV",
          priority: "Medium",
          due_date: addDays(record.initiated_date, 7) || addDays(null, 7),
          description: `Auto-created from BGV ${bid}. Chase the pending checks to completion.`,
          ...links,
        },
        userId,
      )
      break
    }
    case "recruitment_reference_checks": {
      const rid = record.reference_id ? String(record.reference_id) : null
      if (!rid) return
      const status = String(record.result || record.status || "").toLowerCase()
      if (status && DONE_BGV.has(status)) return
      await upsertAutoTask(
        {
          task_id: `AUTOREF-${rid}`,
          task_title: `Complete reference check${who}`,
          task_type: "Reference",
          priority: "Medium",
          due_date: addDays(record.check_date, 5) || addDays(null, 5),
          description: `Auto-created from reference check ${rid}.`,
          ...links,
        },
        userId,
      )
      break
    }
    case "recruitment_pre_joining": {
      const pid = record.prejoin_id ? String(record.prejoin_id) : null
      if (!pid) return
      const status = String(record.status || "").toLowerCase()
      if (status && DONE_JOIN.has(status)) return
      await upsertAutoTask(
        {
          task_id: `AUTOJOIN-${pid}`,
          task_title: `Confirm joining${who}`,
          task_type: "Joining",
          priority: "High",
          due_date: addDays(record.expected_joining_date, -3) || toDateOnly(record.expected_joining_date),
          description: `Auto-created from pre-joining ${pid}. Confirm the candidate will join on the expected date.`,
          ...links,
        },
        userId,
      )
      break
    }
    default:
      return
  }
}
