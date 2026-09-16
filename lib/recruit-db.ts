import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { nextDocumentId } from "@/lib/settings/numbering"
import type { JobQuestion, StageKey } from "@/lib/recruit"
import { normalizeStage, stageRank, isTerminalStage, type CanonicalStage } from "@/lib/recruitment-stages"

// Phase 54: record-level permission scope fragment produced by
// scopeWhereForModule() in lib/permission-enforce.ts. The legacy recruit_*
// list functions accept it so restricted recruiters only ever read the rows
// their configured scope (added / owned / both) permits.
export type RecruitScope = { sql: string; params: any[] } | null

/** Append a scope fragment to a WHERE/args pair, aliasing the given table. */
function applyScope(baseWhere: string, args: any[], scope: RecruitScope) {
  if (!scope) return { where: baseWhere, args }
  const clause = scope.sql
  const where = baseWhere ? `${baseWhere} AND ${clause}` : `WHERE ${clause}`
  return { where, args: [...args, ...scope.params] }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Job = {
  id: number
  job_id: string
  public_hash: string
  title: string
  department: string | null
  location: string | null
  job_type: string | null
  work_mode: string | null
  status: string
  positions: number
  experience: string | null
  salary_from: number | null
  salary_to: number | null
  currency: string
  start_date: string | null
  end_date: string | null
  recruiter: string | null
  skills: string | null
  description: string | null
  requirements: string | null
  show_on_careers: number
  created_at: string
  applications_count?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHash() {
  return crypto.randomBytes(16).toString("hex")
}

function parseQuestions(rows: any[]): JobQuestion[] {
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    type: r.type,
    required: !!r.required,
    sort_order: r.sort_order,
    options: safeParseArray(r.options),
  }))
}

function safeParseArray(value: any): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return String(value).split(",").map((s) => s.trim()).filter(Boolean)
  }
}

export function safeParseObject(value: any): Record<string, any> {
  if (!value) return {}
  if (typeof value === "object") return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export async function listJobs(scope?: RecruitScope) {
  const { where, args } = applyScope("", [], scope ? { sql: scope.sql.replace(/\bcreated_by\b/g, "j.created_by"), params: scope.params } : null)
  return query<Job[]>(
    `SELECT j.*, (SELECT COUNT(*) FROM recruit_applications a WHERE a.job_id = j.job_id) AS applications_count
     FROM recruit_jobs j ${where} ORDER BY j.created_at DESC LIMIT 500`,
    args,
  )
}

export async function getJobById(jobId: string) {
  const rows = await query<Job[]>("SELECT * FROM recruit_jobs WHERE job_id = ? LIMIT 1", [jobId])
  return rows[0] ?? null
}

export async function getJobByHash(hash: string) {
  const rows = await query<Job[]>("SELECT * FROM recruit_jobs WHERE public_hash = ? LIMIT 1", [hash])
  return rows[0] ?? null
}

export async function getJobQuestions(jobId: string) {
  const rows = await query<any[]>(
    "SELECT * FROM recruit_job_questions WHERE job_id = ? ORDER BY sort_order ASC, id ASC",
    [jobId],
  )
  return parseQuestions(rows)
}

async function saveQuestions(jobId: string, questions: JobQuestion[]) {
  await query("DELETE FROM recruit_job_questions WHERE job_id = ?", [jobId])
  let order = 0
  for (const q of questions) {
    if (!q.question?.trim()) continue
    await query(
      "INSERT INTO recruit_job_questions (job_id, question, type, options, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [jobId, q.question.trim(), q.type || "text", JSON.stringify(q.options || []), q.required ? 1 : 0, order++],
    )
  }
}

export async function createJob(data: any, userId: number | null) {
  // Uses the configured recruit.job_prefix (falls back to JOB).
  const jobId = await nextDocumentId("job")
  const hash = makeHash()
  await query(
    `INSERT INTO recruit_jobs
      (job_id, public_hash, title, department, location, job_type, work_mode, status, positions,
       experience, salary_from, salary_to, currency, start_date, end_date, recruiter, skills,
       description, requirements, show_on_careers, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      jobId, hash, data.title, data.department || null, data.location || null, data.job_type || null,
      data.work_mode || null, data.status || "open", Number(data.positions) || 1, data.experience || null,
      data.salary_from || null, data.salary_to || null, data.currency || "INR", data.start_date || null,
      data.end_date || null, data.recruiter || null, data.skills || null, data.description || null,
      data.requirements || null, data.show_on_careers ? 1 : 0, userId,
    ],
  )
  await saveQuestions(jobId, data.questions || [])
  return { job_id: jobId, public_hash: hash }
}

export async function updateJob(jobId: string, data: any) {
  await query(
    `UPDATE recruit_jobs SET title=?, department=?, location=?, job_type=?, work_mode=?, status=?,
      positions=?, experience=?, salary_from=?, salary_to=?, currency=?, start_date=?, end_date=?,
      recruiter=?, skills=?, description=?, requirements=?, show_on_careers=? WHERE job_id=?`,
    [
      data.title, data.department || null, data.location || null, data.job_type || null, data.work_mode || null,
      data.status || "open", Number(data.positions) || 1, data.experience || null, data.salary_from || null,
      data.salary_to || null, data.currency || "INR", data.start_date || null, data.end_date || null,
      data.recruiter || null, data.skills || null, data.description || null, data.requirements || null,
      data.show_on_careers ? 1 : 0, jobId,
    ],
  )
  if (Array.isArray(data.questions)) await saveQuestions(jobId, data.questions)
}

export async function deleteJob(jobId: string) {
  await query("DELETE FROM recruit_job_questions WHERE job_id = ?", [jobId])
  await query("DELETE FROM recruit_jobs WHERE job_id = ?", [jobId])
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------
export async function listApplications(jobId?: string, scope?: RecruitScope) {
  const baseWhere = jobId ? "WHERE job_id = ?" : ""
  const baseArgs: any[] = jobId ? [jobId] : []
  const { where, args } = applyScope(baseWhere, baseArgs, scope ?? null)
  const rows = await query<any[]>(
    `SELECT * FROM recruit_applications ${where} ORDER BY applied_at DESC ${jobId ? "" : "LIMIT 1000"}`,
    args,
  )
  // Phase 11: surface every row in the one canonical stage vocabulary so legacy
  // values (e.g. "phone_screen", "offered") render correctly in the pipeline UI.
  for (const r of rows) r.stage = normalizeStage(r.stage)
  return rows
}

export async function createApplication(data: any, userId: number | null) {
  const applicationId = await nextRecordId("JAP")
  let jobTitle = data.job_title || null
  // Adopt the requisition from the application's job when not supplied, so every
  // application rolls up to the same Requisition -> Job spine (Phase 10).
  let requisitionId = data.requisition_id || null
  if (data.job_id && (!jobTitle || !requisitionId)) {
    const job = await getJobById(data.job_id)
    if (!jobTitle) jobTitle = job?.title ?? null
    if (!requisitionId) requisitionId = (job as any)?.requisition_id ?? null
  }
  // Self-heal the unified-flow columns so this never crashes on a not-yet-migrated DB.
  try {
    const { ensureUnificationSchema } = await import("@/lib/recruit-unification-db")
    await ensureUnificationSchema()
  } catch {}
  await query(
    `INSERT INTO recruit_applications
      (application_id, job_id, job_title, requisition_id, candidate_name, email, phone, location, experience,
       current_company, expected_salary, resume_url, cover_letter, source, campaign, recruiter, stage, rating,
       answers, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      applicationId, data.job_id || null, jobTitle, requisitionId, data.candidate_name, data.email || null,
      data.phone || null, data.location || null, data.experience || null, data.current_company || null,
      data.expected_salary || null, data.resume_url || null, data.cover_letter || null, data.source || "Direct",
      data.campaign || null, data.recruiter || null, data.stage || "applied", Number(data.rating) || 0,
      data.answers ? JSON.stringify(data.answers) : null, userId,
    ],
  )
  // Link the application into the unified candidate spine. This creates/enriches
  // the canonical Candidate Master (recruitment_candidates) — the single source
  // of truth for candidate profiles — and cross-links it to this application, so
  // the profile survives even if the application (or whole job) is later deleted.
  // Best-effort: never block the application on this.
  try {
    const { linkApplicationToMaster } = await import("@/lib/recruit-unification-db")
    await linkApplicationToMaster(applicationId, { ...data, job_title: jobTitle })
  } catch {}
  // Phase 39: the application itself is the first event on the ONE central
  // candidate timeline. Record it (best-effort, idempotent per application) so
  // every candidate — including Careers Site applicants — starts with an
  // "Application" activity that the rest of the pipeline then builds on.
  try {
    const { recordCandidateActivity } = await import("@/lib/recruit-unification-db")
    await recordCandidateActivity({
      application_id: applicationId,
      candidate_name: data.candidate_name,
      job_applied: jobTitle,
      requisition_id: requisitionId,
      email: data.email,
      phone: data.phone,
      activity_type: "Application",
      activity_date: data.applied_at || null,
      subject: jobTitle ? `Applied — ${jobTitle}` : "Application received",
      outcome: data.stage || "applied",
      notes: data.source ? `Source: ${data.source}` : null,
      source_type: "application",
      source_ref: applicationId,
      created_by: userId,
    })
  } catch {}
  return { application_id: applicationId }
}

export async function updateApplication(applicationId: string, data: any) {
  const fields: string[] = []
  const values: any[] = []
  const allowed = ["candidate_name", "email", "phone", "location", "experience", "current_company",
    "expected_salary", "resume_url", "cover_letter", "source", "stage", "rating", "job_id", "job_title"]
  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = ?`)
      values.push(key === "stage" ? normalizeStage(data[key]) : data[key])
    }
  }
  if (fields.length === 0) return
  values.push(applicationId)
  await query(`UPDATE recruit_applications SET ${fields.join(", ")} WHERE application_id = ?`, values)
}

export async function getApplicationById(applicationId: string) {
  const rows = await query<any[]>("SELECT * FROM recruit_applications WHERE application_id = ? LIMIT 1", [applicationId])
  return rows[0] ?? null
}

export async function updateApplicationStage(applicationId: string, stage: StageKey) {
  await query("UPDATE recruit_applications SET stage = ? WHERE application_id = ?", [normalizeStage(stage), applicationId])
}

export async function deleteApplication(applicationId: string) {
  await query("DELETE FROM recruit_applications WHERE application_id = ?", [applicationId])
}

// ---------------------------------------------------------------------------
// Candidate database — RETIRED parallel store
// ---------------------------------------------------------------------------
// The Candidate Database used to live in its own recruit_candidates table,
// written on every application alongside the operational recruit_applications
// row. Per the unification model the CANONICAL person is now the Candidate
// Master (recruitment_candidates), so this parallel profile store has been
// removed. Application creation links into the Master via
// linkApplicationToMaster(), and the Candidate Database page reads through
// listCandidateDatabase() in lib/recruit-unification-db.ts. Legacy
// recruit_candidates data is folded into the Master by the
// 2026-10-08-recruit-candidate-master-consolidation.sql migration.

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------
export async function listInterviews(scope?: RecruitScope) {
  const { where, args } = applyScope("", [], scope ?? null)
  return query<any[]>(`SELECT * FROM recruit_interviews ${where} ORDER BY scheduled_at DESC LIMIT 1000`, args)
}

export async function createInterview(data: any, userId: number | null) {
  const interviewId = await nextRecordId("ISC")
  await query(
    `INSERT INTO recruit_interviews
      (interview_id, application_id, candidate_name, job_title, interviewer, scheduled_at, mode, location,
       round, status, rating, feedback, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      interviewId, data.application_id || null, data.candidate_name || null, data.job_title || null,
      data.interviewer || null, data.scheduled_at || null, data.mode || null, data.location || null,
      data.round || null, data.status || "scheduled", Number(data.rating) || 0, data.feedback || null, userId,
    ],
  )
  return { interview_id: interviewId }
}

export async function getInterviewById(interviewId: string) {
  const rows = await query<any[]>("SELECT * FROM recruit_interviews WHERE interview_id = ? LIMIT 1", [interviewId])
  return rows[0] ?? null
}

export async function updateInterview(interviewId: string, data: any) {
  await query(
    `UPDATE recruit_interviews SET application_id=?, candidate_name=?, job_title=?, interviewer=?,
      scheduled_at=?, mode=?, location=?, round=?, status=?, rating=?, feedback=? WHERE interview_id=?`,
    [
      data.application_id || null, data.candidate_name || null, data.job_title || null, data.interviewer || null,
      data.scheduled_at || null, data.mode || null, data.location || null, data.round || null,
      data.status || "scheduled", Number(data.rating) || 0, data.feedback || null, interviewId,
    ],
  )
}

export async function deleteInterview(interviewId: string) {
  await query("DELETE FROM recruit_interviews WHERE interview_id = ?", [interviewId])
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------
export async function listOffers(scope?: RecruitScope) {
  const { where, args } = applyScope("", [], scope ?? null)
  return query<any[]>(`SELECT * FROM recruit_offers ${where} ORDER BY created_at DESC LIMIT 1000`, args)
}

export async function createOffer(data: any, userId: number | null) {
  const offerId = await nextRecordId("OFL")
  await query(
    `INSERT INTO recruit_offers
      (offer_id, application_id, candidate_name, job_title, salary, currency, joining_date, expiry_date, status, content, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      offerId, data.application_id || null, data.candidate_name || null, data.job_title || null,
      data.salary || null, data.currency || "INR", data.joining_date || null, data.expiry_date || null,
      data.status || "draft", data.content || null, userId,
    ],
  )
  return { offer_id: offerId }
}

export async function getOfferById(offerId: string) {
  const rows = await query<any[]>("SELECT * FROM recruit_offers WHERE offer_id = ? LIMIT 1", [offerId])
  return rows[0] ?? null
}

export async function updateOffer(offerId: string, data: any) {
  await query(
    `UPDATE recruit_offers SET application_id=?, candidate_name=?, job_title=?, salary=?, currency=?,
      joining_date=?, expiry_date=?, status=?, content=? WHERE offer_id=?`,
    [
      data.application_id || null, data.candidate_name || null, data.job_title || null, data.salary || null,
      data.currency || "INR", data.joining_date || null, data.expiry_date || null, data.status || "draft",
      data.content || null, offerId,
    ],
  )
}

export async function deleteOffer(offerId: string) {
  await query("DELETE FROM recruit_offers WHERE offer_id = ?", [offerId])
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export async function listSkills() {
  return query<any[]>("SELECT * FROM recruit_job_skills ORDER BY name ASC")
}

export async function createSkill(name: string, userId: number | null) {
  const skillId = await nextRecordId("JSK")
  await query("INSERT INTO recruit_job_skills (skill_id, name, created_by) VALUES (?,?,?)", [skillId, name.trim(), userId])
  return { skill_id: skillId }
}

export async function deleteSkill(skillId: string) {
  await query("DELETE FROM recruit_job_skills WHERE skill_id = ?", [skillId])
}

// ---------------------------------------------------------------------------
// Dashboard + report
// ---------------------------------------------------------------------------
/**
 * Run a scalar-count query that may hit an optional / not-yet-migrated table.
 * Returns 0 instead of throwing so the dashboard always renders. This is how the
 * Phase 73 counters read straight from the real onboarding tables (BGV, reference
 * checks, follow-ups) without assuming every migration has been applied.
 */
async function safeCount(sql: string, args: any[] = []): Promise<number> {
  try {
    const [row] = await query<any[]>(sql, args)
    return Number(row?.c || 0)
  } catch {
    return 0
  }
}

/**
 * PHASE 73/74: the Recruit dashboard reads every counter and the funnel from the
 * ONE canonical pipeline (recruit_applications, normalised to canonical stages)
 * plus the real stage tables (interviews, offers, BGV, reference checks,
 * follow-ups). No hand-entered totals — advancing a candidate updates the
 * numbers automatically.
 */
export async function getDashboardStats() {
  const [jobAgg] = await query<any[]>(
    "SELECT COUNT(*) AS total, SUM(status='open') AS open_jobs, COALESCE(SUM(positions),0) AS positions FROM recruit_jobs",
  )
  const [appAgg] = await query<any[]>("SELECT COUNT(*) AS total FROM recruit_applications")
  const stageRows = await query<any[]>("SELECT stage, COUNT(*) AS count FROM recruit_applications GROUP BY stage")
  const [intAgg] = await query<any[]>(
    "SELECT COUNT(*) AS total, SUM(status='scheduled') AS upcoming FROM recruit_interviews",
  )
  const [offerAgg] = await query<any[]>(
    "SELECT COUNT(*) AS total, SUM(status='accepted') AS accepted FROM recruit_offers",
  )
  const recentApplications = await query<any[]>(
    "SELECT application_id, candidate_name, job_title, stage, applied_at FROM recruit_applications ORDER BY applied_at DESC LIMIT 6",
  )
  const upcomingInterviews = await query<any[]>(
    "SELECT interview_id, candidate_name, job_title, scheduled_at, mode, status FROM recruit_interviews WHERE status='scheduled' ORDER BY scheduled_at ASC LIMIT 6",
  )

  // Collapse every raw/legacy stage value into the single canonical vocabulary
  // so "screening", "phone_screen", "Offer Accepted" etc. all land in one bucket.
  const stageCounts: Record<string, number> = {}
  for (const r of stageRows) {
    const key = normalizeStage(r.stage)
    stageCounts[key] = (stageCounts[key] || 0) + Number(r.count)
  }
  const atStage = (s: CanonicalStage) => stageCounts[s] || 0

  // PHASE 74 funnel: cumulative "reached at least this stage" counts derived from
  // each application's CURRENT canonical stage. Terminal stages (rejected/hold/
  // withdrawn) count only as an application — we don't know how far they got.
  const funnelSteps: { key: string; label: string; rank: number }[] = [
    { key: "applications", label: "Applications", rank: 0 },
    { key: "screening", label: "Screening", rank: 1 },
    { key: "shortlisted", label: "Shortlisted", rank: 2 },
    { key: "assessment", label: "Assessment", rank: 3 },
    { key: "interview", label: "Interview", rank: 4 },
    { key: "selected", label: "Selected", rank: 5 },
    { key: "offer", label: "Offer", rank: 6 },
    { key: "accepted", label: "Accepted", rank: 7 },
    { key: "joined", label: "Joined", rank: 9 },
  ]
  const funnelCounts = new Map<string, number>(funnelSteps.map((s) => [s.key, 0]))
  for (const [stageKey, count] of Object.entries(stageCounts)) {
    const stage = stageKey as CanonicalStage
    // Everyone is an application.
    funnelCounts.set("applications", (funnelCounts.get("applications") || 0) + count)
    if (isTerminalStage(stage)) continue
    const r = stageRank(stage)
    for (const step of funnelSteps) {
      if (step.key === "applications") continue
      if (r >= step.rank) funnelCounts.set(step.key, (funnelCounts.get(step.key) || 0) + count)
    }
  }
  const funnel = funnelSteps.map((s) => ({ key: s.key, label: s.label, count: funnelCounts.get(s.key) || 0 }))

  // PHASE 73 counters. Optional tables are read best-effort (safeCount) so an
  // un-migrated database still renders the dashboard with zeros.
  const [
    openRequisitions,
    upcomingJoining,
    pendingBgv,
    pendingReference,
    pendingFeedback,
    dueFollowups,
  ] = await Promise.all([
    safeCount(
      "SELECT COUNT(*) AS c FROM recruitment_requisitions WHERE LOWER(COALESCE(status,'')) NOT IN ('closed','filled','cancelled','rejected','completed','on hold')",
    ),
    safeCount(
      "SELECT COUNT(*) AS c FROM recruit_offers WHERE status='accepted' AND joining_date IS NOT NULL AND joining_date >= CURDATE()",
    ),
    safeCount("SELECT COUNT(*) AS c FROM recruit_bgv_checks WHERE LOWER(COALESCE(status,'')) NOT IN ('completed','cleared','passed')"),
    safeCount("SELECT COUNT(*) AS c FROM recruit_reference_checks WHERE LOWER(COALESCE(status,'')) NOT IN ('completed','cleared','passed')"),
    safeCount(
      "SELECT COUNT(*) AS c FROM recruit_interviews WHERE LOWER(COALESCE(status,''))='completed' AND (feedback IS NULL OR feedback='')",
    ),
    safeCount(
      "SELECT COUNT(*) AS c FROM recruitment_followups WHERE next_followup_date IS NOT NULL AND next_followup_date <= CURDATE() AND LOWER(COALESCE(status,'')) NOT IN ('done','closed','completed','cancelled')",
    ),
  ])

  const pipeline = {
    openJobs: Number(jobAgg?.open_jobs || 0),
    openRequisitions,
    applications: Number(appAgg?.total || 0),
    screening: atStage("screening"),
    shortlisted: atStage("shortlisted"),
    assessments: atStage("assessment"),
    interviews: Number(intAgg?.total || 0),
    selected: atStage("selected"),
    offers: Number(offerAgg?.total || 0),
    acceptedOffers: Number(offerAgg?.accepted || 0),
    upcomingJoining,
    joined: atStage("hired"),
    pendingBgv,
    pendingReference,
    pendingFeedback,
    dueFollowups,
  }

  // Phases 66-68: surface stalled pipeline work (stale applications /
  // requisitions / jobs) right on the dashboard. Best-effort so the dashboard
  // still renders on a not-yet-migrated database.
  const { getStaleSummary } = await import("@/lib/recruit-stale-detection")
  const stale = await getStaleSummary().catch(() => null)

  return {
    jobs: { total: Number(jobAgg?.total || 0), open: Number(jobAgg?.open_jobs || 0), positions: Number(jobAgg?.positions || 0) },
    applications: { total: Number(appAgg?.total || 0), byStage: stageCounts },
    interviews: { total: Number(intAgg?.total || 0), upcoming: Number(intAgg?.upcoming || 0) },
    offers: { total: Number(offerAgg?.total || 0), accepted: Number(offerAgg?.accepted || 0) },
    pipeline,
    funnel,
    recentApplications,
    upcomingInterviews,
    stale,
  }
}

export async function getJobReport() {
  return query<any[]>(
    `SELECT
        j.job_id, j.title, j.department, j.status, j.positions,
        COUNT(a.id) AS applications,
        SUM(a.stage='interview') AS interviews,
        SUM(a.stage IN ('offer','offered','offer_accepted')) AS offered,
        SUM(a.stage IN ('hired','joined')) AS hired,
        SUM(a.stage IN ('rejected','withdrawn')) AS rejected
     FROM recruit_jobs j
     LEFT JOIN recruit_applications a ON a.job_id = j.job_id
     GROUP BY j.id
     ORDER BY applications DESC`,
  )
}
