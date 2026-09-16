import "server-only"
import { query } from "@/lib/db"
import { normalizeStage, stageRank, type CanonicalStage } from "@/lib/recruitment-stages"

/**
 * Phase 88/89/90 — 360-degree detail aggregators for the three remaining spine
 * entities (Job, Requisition, Application). Each reads across the unified
 * recruitment flow and returns everything a dedicated detail page needs.
 *
 * Every read is best-effort: a not-yet-migrated table/column degrades to an
 * empty result instead of crashing a page. This mirrors the resilience of
 * getCandidate360 in lib/recruit-unification-db.ts.
 */

function isMissingSchema(err: any): boolean {
  const code = err?.code || err?.original?.code
  return code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR"
}

async function safe<T = any[]>(sql: string, params: any[] = [], fallback: T = [] as unknown as T): Promise<T> {
  try {
    return await query<T>(sql, params)
  } catch (err) {
    if (isMissingSchema(err)) return fallback
    throw err
  }
}

function inClause(values: string[]): { clause: string; args: string[] } {
  const clean = values.filter(Boolean)
  if (!clean.length) return { clause: "", args: [] }
  return { clause: clean.map(() => "?").join(","), args: clean }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------------------
// Application-stage funnel counts shared by Job + Requisition detail
// ---------------------------------------------------------------------------
export type PipelineCounts = {
  total: number
  applied: number
  screening: number
  shortlisted: number
  interview: number
  offer: number
  selected: number
  joined: number
  rejected: number
}

function tallyApplications(apps: any[]): PipelineCounts {
  const c: PipelineCounts = {
    total: apps.length,
    applied: 0,
    screening: 0,
    shortlisted: 0,
    interview: 0,
    offer: 0,
    selected: 0,
    joined: 0,
    rejected: 0,
  }
  const shortlistedRank = stageRank("shortlisted")
  const interviewRank = stageRank("interview")
  const selectedRank = stageRank("selected")
  for (const a of apps) {
    const stage = normalizeStage(a.stage)
    if (stage === "hired") c.joined++
    if (stage === "rejected" || stage === "withdrawn" || stage === "hold") {
      c.rejected++
      continue
    }
    if (stage === "applied") c.applied++
    if (stage === "screening") c.screening++
    if (stage === "offer" || stage === "offer_accepted") c.offer++
    const rank = stageRank(stage)
    if (rank >= shortlistedRank) c.shortlisted++
    if (rank >= interviewRank && stage !== "hired") c.interview++
    if (rank >= selectedRank) c.selected++
  }
  return c
}

// ===========================================================================
// Phase 88 — Job detail
// ===========================================================================
export type JobDetail = {
  job: any
  requisition: any | null
  applications: any[]
  interviews: any[]
  offers: any[]
  counts: PipelineCounts
  remaining: number
}

export async function getJobDetail(jobId: string): Promise<JobDetail | null> {
  const key = String(jobId).trim()
  if (!key) return null

  const job = (await safe<any[]>("SELECT * FROM recruit_jobs WHERE job_id = ? LIMIT 1", [key]))[0] || null
  if (!job) return null

  const requisition = job.requisition_id
    ? (await safe<any[]>("SELECT * FROM recruitment_requisitions WHERE requisition_id = ? LIMIT 1", [
        job.requisition_id,
      ]))[0] || null
    : null

  const applications = await safe<any[]>(
    "SELECT * FROM recruit_applications WHERE job_id = ? ORDER BY applied_at DESC LIMIT 1000",
    [key],
  )
  for (const a of applications) a.stage = normalizeStage(a.stage)

  const appIds = applications.map((a) => a.application_id).filter(Boolean)
  const { clause, args } = inClause(appIds)

  const [interviews, offers] = await Promise.all([
    clause
      ? safe<any[]>(
          `SELECT * FROM recruit_interviews WHERE application_id IN (${clause}) ORDER BY scheduled_at DESC LIMIT 500`,
          args,
        )
      : Promise.resolve([]),
    clause
      ? safe<any[]>(
          `SELECT * FROM recruit_offers WHERE application_id IN (${clause}) ORDER BY created_at DESC LIMIT 500`,
          args,
        )
      : Promise.resolve([]),
  ])

  const counts = tallyApplications(applications)
  const positions = num(job.positions) || 0
  const remaining = Math.max(0, positions - counts.joined)

  return { job, requisition, applications, interviews, offers, counts, remaining }
}

// ===========================================================================
// Phase 89 — Requisition detail
// ===========================================================================
export type RequisitionDetail = {
  requisition: any
  jobs: any[]
  applications: any[]
  counts: PipelineCounts
  headcount: { required: number; filled: number; pending: number; remaining: number }
  budget: { budget: number; actual: number; variance: number; entries: any[] }
}

export async function getRequisitionDetail(requisitionId: string): Promise<RequisitionDetail | null> {
  const key = String(requisitionId).trim()
  if (!key) return null

  const requisition = (await safe<any[]>(
    "SELECT * FROM recruitment_requisitions WHERE requisition_id = ? LIMIT 1",
    [key],
  ))[0] || null
  if (!requisition) return null

  // Jobs linked to this requisition (either direction of the link).
  const jobs = await safe<any[]>(
    "SELECT * FROM recruit_jobs WHERE requisition_id = ? OR job_id = ? ORDER BY created_at DESC",
    [key, requisition.linked_job_id || ""],
  )
  const jobIds = jobs.map((j) => j.job_id).filter(Boolean)

  // Applications reached this requisition via any linked job OR directly.
  const jobIn = inClause(jobIds)
  const appConds: string[] = ["requisition_id = ?"]
  const appArgs: any[] = [key]
  if (jobIn.clause) {
    appConds.push(`job_id IN (${jobIn.clause})`)
    appArgs.push(...jobIn.args)
  }
  const applications = await safe<any[]>(
    `SELECT * FROM recruit_applications WHERE ${appConds.join(" OR ")} ORDER BY applied_at DESC LIMIT 1000`,
    appArgs,
  )
  for (const a of applications) a.stage = normalizeStage(a.stage)

  const counts = tallyApplications(applications)

  const required = num(requisition.required_resources)
  const filledFromApps = counts.joined
  const filled = Math.max(num(requisition.filled_resources), filledFromApps)
  const pending = num(requisition.pending_resources) || Math.max(0, required - filled)
  const remaining = Math.max(0, required - filled)

  // Budget vs actual recruitment cost.
  const costEntries = await safe<any[]>(
    "SELECT * FROM recruitment_costs WHERE requisition_id = ? ORDER BY cost_date DESC LIMIT 500",
    [key],
  )
  let budget = 0
  let actual = 0
  for (const c of costEntries) {
    budget += num(c.budget_amount)
    actual += num(c.actual_amount)
  }

  return {
    requisition,
    jobs,
    applications,
    counts,
    headcount: { required, filled, pending, remaining },
    budget: { budget, actual, variance: budget - actual, entries: costEntries },
  }
}

// ===========================================================================
// Phase 90 — Application detail
// ===========================================================================
export type ApplicationDetail = {
  application: any
  candidate: any | null
  job: any | null
  requisition: any | null
  screenings: any[]
  assessments: any[]
  interviews: any[]
  feedback: any[]
  selections: any[]
  offers: any[]
  verifications: any[]
  references: any[]
  preJoining: any[]
  employee: any | null
}

export async function getApplicationDetail(applicationId: string): Promise<ApplicationDetail | null> {
  const key = String(applicationId).trim()
  if (!key) return null

  const application = (await safe<any[]>(
    "SELECT * FROM recruit_applications WHERE application_id = ? LIMIT 1",
    [key],
  ))[0] || null
  if (!application) return null

  const candidate = application.candidate_master_id
    ? (await safe<any[]>("SELECT * FROM recruitment_candidates WHERE candidate_id = ? LIMIT 1", [
        application.candidate_master_id,
      ]))[0] || null
    : null

  const job = application.job_id
    ? (await safe<any[]>("SELECT * FROM recruit_jobs WHERE job_id = ? LIMIT 1", [application.job_id]))[0] || null
    : null

  const reqId = application.requisition_id || job?.requisition_id || null
  const requisition = reqId
    ? (await safe<any[]>("SELECT * FROM recruitment_requisitions WHERE requisition_id = ? LIMIT 1", [reqId]))[0] || null
    : null

  const cid = candidate?.candidate_id || application.candidate_master_id || null

  // Config-driven module stage tables link by candidate_id or application_id.
  const byLink = async (table: string) => {
    const conds: string[] = []
    const args: any[] = []
    conds.push("application_id = ?")
    args.push(key)
    if (cid) {
      conds.push("candidate_id = ?")
      args.push(cid)
    }
    return safe<any[]>(`SELECT * FROM ${table} WHERE ${conds.join(" OR ")} ORDER BY id DESC LIMIT 200`, args)
  }
  // Operational tables link by application_id only.
  const byApp = async (table: string, orderCol = "created_at") =>
    safe<any[]>(`SELECT * FROM ${table} WHERE application_id = ? ORDER BY ${orderCol} DESC LIMIT 200`, [key])

  const [
    screenings,
    assessments,
    moduleInterviews,
    opInterviews,
    feedback,
    selections,
    offers,
    moduleBgv,
    opBgv,
    moduleRef,
    opRef,
    modulePrj,
    opPrj,
  ] = await Promise.all([
    byLink("recruitment_screening"),
    byLink("recruitment_assessments"),
    byLink("recruitment_interviews"),
    byApp("recruit_interviews", "scheduled_at"),
    byLink("recruitment_interview_feedback"),
    byLink("recruitment_selections"),
    byApp("recruit_offers"),
    byLink("recruitment_background_verification"),
    byApp("recruit_bgv_checks", "initiated_at"),
    byLink("recruitment_reference_checks"),
    byApp("recruit_reference_checks", "checked_at"),
    byLink("recruitment_pre_joining"),
    byApp("recruit_prejoining_tasks", "due_date"),
  ])

  const employee = application.hired_employee_id
    ? (await safe<any[]>("SELECT * FROM hr_employees WHERE employee_id = ? LIMIT 1", [
        application.hired_employee_id,
      ]))[0] || null
    : null

  return {
    application,
    candidate,
    job,
    requisition,
    screenings,
    assessments,
    interviews: [...opInterviews, ...moduleInterviews],
    feedback,
    selections,
    offers,
    verifications: [...opBgv, ...moduleBgv],
    references: [...opRef, ...moduleRef],
    preJoining: [...opPrj, ...modulePrj],
    employee,
  }
}
