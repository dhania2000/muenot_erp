import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import type { JobQuestion, StageKey } from "@/lib/recruit"

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
export async function listJobs() {
  return query<Job[]>(
    `SELECT j.*, (SELECT COUNT(*) FROM recruit_applications a WHERE a.job_id = j.job_id) AS applications_count
     FROM recruit_jobs j ORDER BY j.created_at DESC LIMIT 500`,
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
  const jobId = await nextRecordId("JOB")
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
export async function listApplications(jobId?: string) {
  if (jobId) {
    return query<any[]>("SELECT * FROM recruit_applications WHERE job_id = ? ORDER BY applied_at DESC", [jobId])
  }
  return query<any[]>("SELECT * FROM recruit_applications ORDER BY applied_at DESC LIMIT 1000")
}

export async function createApplication(data: any, userId: number | null) {
  const applicationId = await nextRecordId("JAP")
  let jobTitle = data.job_title || null
  if (data.job_id && !jobTitle) {
    const job = await getJobById(data.job_id)
    jobTitle = job?.title ?? null
  }
  await query(
    `INSERT INTO recruit_applications
      (application_id, job_id, job_title, candidate_name, email, phone, location, experience,
       current_company, expected_salary, resume_url, cover_letter, source, stage, rating, answers, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      applicationId, data.job_id || null, jobTitle, data.candidate_name, data.email || null, data.phone || null,
      data.location || null, data.experience || null, data.current_company || null, data.expected_salary || null,
      data.resume_url || null, data.cover_letter || null, data.source || "Direct", data.stage || "applied",
      Number(data.rating) || 0, data.answers ? JSON.stringify(data.answers) : null, userId,
    ],
  )
  return { application_id: applicationId }
}

export async function updateApplication(applicationId: string, data: any) {
  const fields: string[] = []
  const values: any[] = []
  const allowed = ["candidate_name", "email", "phone", "location", "experience", "current_company",
    "expected_salary", "resume_url", "cover_letter", "source", "stage", "rating", "job_id", "job_title"]
  for (const key of allowed) {
    if (key in data) { fields.push(`${key} = ?`); values.push(data[key]) }
  }
  if (fields.length === 0) return
  values.push(applicationId)
  await query(`UPDATE recruit_applications SET ${fields.join(", ")} WHERE application_id = ?`, values)
}

export async function updateApplicationStage(applicationId: string, stage: StageKey) {
  await query("UPDATE recruit_applications SET stage = ? WHERE application_id = ?", [stage, applicationId])
}

export async function deleteApplication(applicationId: string) {
  await query("DELETE FROM recruit_applications WHERE application_id = ?", [applicationId])
}

// ---------------------------------------------------------------------------
// Candidate database (aggregated from applications)
// ---------------------------------------------------------------------------
export async function listCandidates() {
  return query<any[]>(
    `SELECT
        candidate_name, email,
        MAX(phone) AS phone,
        MAX(location) AS location,
        MAX(current_company) AS current_company,
        MAX(experience) AS experience,
        COUNT(*) AS applications_count,
        GROUP_CONCAT(DISTINCT job_title SEPARATOR ', ') AS jobs,
        MAX(rating) AS rating,
        MAX(applied_at) AS last_applied
     FROM recruit_applications
     GROUP BY candidate_name, email
     ORDER BY last_applied DESC
     LIMIT 1000`,
  )
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------
export async function listInterviews() {
  return query<any[]>("SELECT * FROM recruit_interviews ORDER BY scheduled_at DESC LIMIT 1000")
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
export async function listOffers() {
  return query<any[]>("SELECT * FROM recruit_offers ORDER BY created_at DESC LIMIT 1000")
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
  const stageCounts: Record<string, number> = {}
  for (const r of stageRows) stageCounts[r.stage] = Number(r.count)

  return {
    jobs: { total: Number(jobAgg?.total || 0), open: Number(jobAgg?.open_jobs || 0), positions: Number(jobAgg?.positions || 0) },
    applications: { total: Number(appAgg?.total || 0), byStage: stageCounts },
    interviews: { total: Number(intAgg?.total || 0), upcoming: Number(intAgg?.upcoming || 0) },
    offers: { total: Number(offerAgg?.total || 0), accepted: Number(offerAgg?.accepted || 0) },
    recentApplications,
    upcomingInterviews,
  }
}

export async function getJobReport() {
  return query<any[]>(
    `SELECT
        j.job_id, j.title, j.department, j.status, j.positions,
        COUNT(a.id) AS applications,
        SUM(a.stage='interview') AS interviews,
        SUM(a.stage='offered') AS offered,
        SUM(a.stage='hired') AS hired,
        SUM(a.stage='rejected') AS rejected
     FROM recruit_jobs j
     LEFT JOIN recruit_applications a ON a.job_id = j.job_id
     GROUP BY j.id
     ORDER BY applications DESC`,
  )
}
