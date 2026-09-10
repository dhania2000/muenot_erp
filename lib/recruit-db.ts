import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { nextDocumentId } from "@/lib/settings/numbering"
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
  // Persist / merge the person into the standalone Candidate Database so the
  // profile survives even if this application (or the whole job) is later
  // deleted. Best-effort: a failure here must not block the application.
  try {
    await upsertCandidateProfile(data)
  } catch {}
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
// A candidate may apply to many jobs; each of those stays a separate row in
// recruit_applications (and in the Job Applications view). The Candidate
// Database, however, must show each real person exactly once. Two applications
// belong to the same person when they share a normalized email OR a normalized
// phone number. Because that "email OR phone" match is transitive (A shares an
// email with B, B shares a phone with C => A, B and C are one person), we can't
// express it with a plain SQL GROUP BY. Instead we pull the raw rows and merge
// them with a small union-find pass.
function normalizeEmail(email: unknown): string | null {
  const v = String(email ?? "").trim().toLowerCase()
  return v || null
}

function normalizePhone(phone: unknown): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "")
  if (!digits) return null
  // Compare on the last 10 digits so country-code / formatting differences
  // (e.g. +91 98765 43210 vs 9876543210) still resolve to the same person.
  return digits.length > 10 ? digits.slice(-10) : digits
}

type CandidateAggregate = {
  candidate_name: string
  email: string | null
  phone: string | null
  location: string | null
  current_company: string | null
  experience: string | null
  applications_count: number
  jobs: string | null
  rating: number
  last_applied: string
}

// The Candidate Database is a standalone profile store: once a person applies
// they get a persistent row here that must survive even if their application(s)
// or the whole job get deleted. Applications (and the Job Applications view)
// stay fully separate — deleting there never removes the profile.
let candidatesTableEnsured = false
async function ensureCandidatesTable() {
  if (candidatesTableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS recruit_candidates (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      candidate_name VARCHAR(255) NOT NULL DEFAULT '',
      email VARCHAR(255) DEFAULT NULL,
      phone VARCHAR(60) DEFAULT NULL,
      norm_email VARCHAR(255) DEFAULT NULL,
      norm_phone VARCHAR(20) DEFAULT NULL,
      location VARCHAR(255) DEFAULT NULL,
      current_company VARCHAR(255) DEFAULT NULL,
      experience VARCHAR(120) DEFAULT NULL,
      rating INT NOT NULL DEFAULT 0,
      last_applied TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_norm_email (norm_email),
      KEY idx_norm_phone (norm_phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  candidatesTableEnsured = true
  // One-time backfill so existing applicants already have a persistent profile
  // (otherwise deleting a pre-existing application would lose that person).
  const [{ c } = { c: 0 }] = await query<any[]>("SELECT COUNT(*) AS c FROM recruit_candidates")
  if (Number(c) === 0) {
    const existing = await query<any[]>(
      `SELECT candidate_name, email, phone, location, current_company, experience, rating, applied_at
       FROM recruit_applications ORDER BY applied_at ASC LIMIT 5000`,
    )
    for (const r of existing) {
      try {
        await upsertCandidateProfile({ ...r, applied_at: r.applied_at })
      } catch {}
    }
  }
}

// Insert or merge a person into recruit_candidates. Two rows are the same
// person when they share a normalized email OR phone; on a match we enrich the
// existing profile (fill blanks, keep the latest name, grow the identity keys).
export async function upsertCandidateProfile(data: any) {
  await ensureCandidatesTable()
  const normEmail = normalizeEmail(data.email)
  const normPhone = normalizePhone(data.phone)
  if (!normEmail && !normPhone) return // can't identify the person — skip

  const matches = await query<any[]>(
    `SELECT * FROM recruit_candidates
     WHERE (norm_email IS NOT NULL AND norm_email = ?) OR (norm_phone IS NOT NULL AND norm_phone = ?)
     ORDER BY id ASC LIMIT 1`,
    [normEmail, normPhone],
  )
  const existing = matches[0]
  const appliedAt = data.applied_at ? new Date(data.applied_at) : new Date()
  const rating = Number(data.rating) || 0

  if (!existing) {
    await query(
      `INSERT INTO recruit_candidates
        (candidate_name, email, phone, norm_email, norm_phone, location, current_company, experience, rating, last_applied)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        data.candidate_name || "—", data.email || null, data.phone || null, normEmail, normPhone,
        data.location || null, data.current_company || null, data.experience || null, rating, appliedAt,
      ],
    )
    return
  }

  // Merge into the existing profile: latest name wins, blanks get filled,
  // identity keys grow, rating/last_applied take the max.
  await query(
    `UPDATE recruit_candidates SET
       candidate_name = ?,
       email = COALESCE(email, ?),
       phone = COALESCE(phone, ?),
       norm_email = COALESCE(norm_email, ?),
       norm_phone = COALESCE(norm_phone, ?),
       location = COALESCE(location, ?),
       current_company = COALESCE(current_company, ?),
       experience = COALESCE(experience, ?),
       rating = GREATEST(rating, ?),
       last_applied = GREATEST(COALESCE(last_applied, ?), ?)
     WHERE id = ?`,
    [
      data.candidate_name || existing.candidate_name || "—",
      data.email || null, data.phone || null, normEmail, normPhone,
      data.location || null, data.current_company || null, data.experience || null,
      rating, appliedAt, appliedAt, existing.id,
    ],
  )
}

export async function listCandidates(): Promise<CandidateAggregate[]> {
  await ensureCandidatesTable()

  // Seed identity from BOTH the persistent profiles (so people persist after
  // their applications are deleted) and the live applications (for accurate
  // application counts + the list of jobs they applied to).
  const profiles = await query<any[]>(
    `SELECT candidate_name, email, phone, location, current_company, experience, rating, last_applied
     FROM recruit_candidates LIMIT 5000`,
  )
  const apps = await query<any[]>(
    `SELECT candidate_name, email, phone, location, current_company, experience,
            job_title, rating, applied_at
     FROM recruit_applications ORDER BY applied_at DESC LIMIT 5000`,
  )

  type Node = { isApp: boolean; r: any; ts: string }
  const nodes: Node[] = [
    ...profiles.map((r) => ({ isApp: false, r, ts: String(r.last_applied || "") })),
    ...apps.map((r) => ({ isApp: true, r, ts: String(r.applied_at || "") })),
  ]

  // Union-find over all nodes, linked by shared normalized email / phone.
  const parent: number[] = nodes.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const emailOwner = new Map<string, number>()
  const phoneOwner = new Map<string, number>()
  nodes.forEach((n, i) => {
    const e = normalizeEmail(n.r.email)
    if (e) {
      const prev = emailOwner.get(e)
      if (prev === undefined) emailOwner.set(e, i)
      else union(prev, i)
    }
    const p = normalizePhone(n.r.phone)
    if (p) {
      const prev = phoneOwner.get(p)
      if (prev === undefined) phoneOwner.set(p, i)
      else union(prev, i)
    }
  })

  // Fold each group into one candidate. Process nodes newest-first per group so
  // the first non-empty value we keep for a field is the most recent one.
  const order = nodes
    .map((n, i) => i)
    .sort((a, b) => nodes[b].ts.localeCompare(nodes[a].ts))

  const groups = new Map<number, CandidateAggregate & { _jobs: Set<string> }>()
  for (const i of order) {
    const n = nodes[i]
    const r = n.r
    const root = find(i)
    let g = groups.get(root)
    if (!g) {
      g = {
        candidate_name: r.candidate_name || "—",
        email: normalizeEmail(r.email),
        phone: r.phone || null,
        location: r.location || null,
        current_company: r.current_company || null,
        experience: r.experience || null,
        applications_count: 0,
        jobs: null,
        rating: 0,
        last_applied: n.ts,
        _jobs: new Set<string>(),
      }
      groups.set(root, g)
    }
    if (n.isApp) g.applications_count += 1
    if (!g.candidate_name || g.candidate_name === "—") g.candidate_name = r.candidate_name || g.candidate_name
    if (!g.email) g.email = normalizeEmail(r.email)
    if (!g.phone && r.phone) g.phone = r.phone
    if (!g.location && r.location) g.location = r.location
    if (!g.current_company && r.current_company) g.current_company = r.current_company
    if (!g.experience && r.experience) g.experience = r.experience
    if (n.isApp && r.job_title) g._jobs.add(r.job_title)
    const rating = Number(r.rating) || 0
    if (rating > g.rating) g.rating = rating
    if (n.ts && (!g.last_applied || n.ts > g.last_applied)) g.last_applied = n.ts
  }

  return Array.from(groups.values())
    .map(({ _jobs, ...rest }) => ({
      ...rest,
      jobs: _jobs.size ? Array.from(_jobs).join(", ") : null,
    }))
    .sort((a, b) => String(b.last_applied || "").localeCompare(String(a.last_applied || "")))
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
