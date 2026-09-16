import "server-only"
import { query } from "@/lib/db"
import { nextRecordIdForPrefix } from "@/lib/settings/numbering"

/**
 * Recruitment unification layer.
 *
 * Wires the two historically-separate recruitment worlds into ONE candidate
 * spine:
 *
 *   * Operational pipeline (recruit_applications / recruit_offers /
 *     recruit_interviews / recruit_bgv_checks / recruit_reference_checks /
 *     recruit_prejoining_tasks) — keyed on recruit_applications.application_id.
 *
 *   * Config-driven Recruitment modules (recruitment_candidates a.k.a
 *     "Candidate Master", recruitment_screening, recruitment_interviews,
 *     recruitment_assessments, recruitment_selections,
 *     recruitment_interview_feedback, recruitment_background_verification,
 *     recruitment_reference_checks, recruitment_pre_joining).
 *
 * Per the agreed model the CANONICAL person is the Candidate Master
 * (recruitment_candidates.candidate_id) and every operational application links
 * to it (recruit_applications.candidate_master_id). Stage records link to the
 * operational application via application_id, and resolve back to the canonical
 * candidate through it.
 *
 * All schema is self-healing (ensureUnificationSchema) and every read degrades
 * gracefully when a table/column is not present yet, so this layer can never
 * crash a page that used to work.
 */

// ---------------------------------------------------------------------------
// Identity normalization (kept consistent with lib/recruit-db.ts)
// ---------------------------------------------------------------------------
export function normalizeEmail(email: unknown): string | null {
  const v = String(email ?? "").trim().toLowerCase()
  return v || null
}

export function normalizePhone(phone: unknown): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "")
  if (!digits) return null
  return digits.length > 10 ? digits.slice(-10) : digits
}

function isMissingSchema(err: any): boolean {
  const code = err?.code || err?.original?.code
  return code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR"
}

/** Run a read that may hit not-yet-migrated schema; return a fallback instead of throwing. */
async function safeQuery<T = any[]>(sql: string, params: any[] = [], fallback: T = [] as unknown as T): Promise<T> {
  try {
    return await query<T>(sql, params)
  } catch (err) {
    if (isMissingSchema(err)) return fallback
    throw err
  }
}

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------
const STAGE_TABLES = [
  "recruitment_screening",
  "recruitment_interviews",
  "recruitment_assessments",
  "recruitment_selections",
  "recruitment_interview_feedback",
  "recruitment_background_verification",
  "recruitment_reference_checks",
  "recruitment_pre_joining",
] as const

let schemaEnsured = false
/** Best-effort, idempotent. Each ALTER is independent so one failure can't abort the rest. */
export async function ensureUnificationSchema() {
  if (schemaEnsured) return
  const alters: string[] = [
    "ALTER TABLE recruit_applications ADD COLUMN IF NOT EXISTS candidate_master_id VARCHAR(191) DEFAULT NULL",
    "ALTER TABLE recruit_applications ADD INDEX IF NOT EXISTS idx_app_candidate_master (candidate_master_id)",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS norm_email VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS norm_phone VARCHAR(20) DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD INDEX IF NOT EXISTS idx_cand_application (application_id)",
    "ALTER TABLE recruitment_candidates ADD INDEX IF NOT EXISTS idx_cand_norm_email (norm_email)",
    "ALTER TABLE recruitment_candidates ADD INDEX IF NOT EXISTS idx_cand_norm_phone (norm_phone)",
    ...STAGE_TABLES.flatMap((t) => [
      `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL`,
      `ALTER TABLE ${t} ADD INDEX IF NOT EXISTS idx_${t.slice(0, 20)}_app (application_id)`,
    ]),
  ]
  for (const sql of alters) {
    try {
      await query(sql)
    } catch {
      // Column/index already exists, table not present yet, or engine lacks
      // IF NOT EXISTS — all safe to ignore for this best-effort heal.
    }
  }
  schemaEnsured = true
}

// ---------------------------------------------------------------------------
// Canonical candidate resolution (Candidate Master = recruitment_candidates)
// ---------------------------------------------------------------------------
export type PersonInput = {
  candidate_id?: string | null
  candidate_name?: string | null
  candidate_master_id?: string | null
  email?: string | null
  phone?: string | null
  mobile?: string | null
  location?: string | null
  current_location?: string | null
  current_company?: string | null
  experience?: string | null
  source?: string | null
  job_title?: string | null
  job_applied?: string | null
  requisition_id?: string | null
  application_id?: string | null
  applied_at?: string | Date | null
}

/**
 * Find or create the canonical Candidate Master row for a person and return its
 * candidate_id. Matches an existing person by explicit candidate_id, then by
 * normalized email OR phone. Enriches blanks on a match; creates a CAND row
 * otherwise. Best-effort: returns null if the person can't be identified.
 */
export async function resolveCandidateMaster(person: PersonInput): Promise<string | null> {
  await ensureUnificationSchema()

  const explicitId = String(person.candidate_master_id || person.candidate_id || "").trim() || null
  const email = person.email ?? null
  const phone = person.phone ?? person.mobile ?? null
  const normEmail = normalizeEmail(email)
  const normPhone = normalizePhone(phone)
  const location = person.current_location ?? person.location ?? null
  const job = person.job_applied ?? person.job_title ?? null
  const appliedAt = person.applied_at ? new Date(person.applied_at) : new Date()

  // 1. Explicit candidate_id wins.
  if (explicitId) {
    const rows = await safeQuery<any[]>(
      "SELECT candidate_id FROM recruitment_candidates WHERE candidate_id = ? LIMIT 1",
      [explicitId],
    )
    if (rows[0]) {
      await enrichMaster(explicitId, person, normEmail, normPhone)
      return explicitId
    }
  }

  // 2. Match by normalized identity.
  if (normEmail || normPhone) {
    const rows = await safeQuery<any[]>(
      `SELECT candidate_id FROM recruitment_candidates
        WHERE (norm_email IS NOT NULL AND norm_email = ?) OR (norm_phone IS NOT NULL AND norm_phone = ?)
        ORDER BY id ASC LIMIT 1`,
      [normEmail, normPhone],
    )
    if (rows[0]?.candidate_id) {
      await enrichMaster(rows[0].candidate_id, person, normEmail, normPhone)
      return rows[0].candidate_id
    }
  }

  // Can't identify and no name to seed a profile — skip.
  if (!normEmail && !normPhone && !person.candidate_name) return null

  // 3. Create a new Candidate Master row.
  const candidateId = explicitId || (await nextRecordIdForPrefix("CAND"))
  try {
    await query(
      `INSERT INTO recruitment_candidates
        (candidate_id, candidate_name, email, mobile, norm_email, norm_phone, current_location,
         current_company, experience, source, job_applied, requisition_id, application_id,
         candidate_status, application_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        candidateId,
        person.candidate_name || "—",
        email,
        phone,
        normEmail,
        normPhone,
        location,
        person.current_company || null,
        person.experience || null,
        person.source || null,
        job,
        person.requisition_id || null,
        person.application_id || null,
        "Applied",
        appliedAt,
      ],
    )
    return candidateId
  } catch (err) {
    if (isMissingSchema(err)) return null
    throw err
  }
}

/** Fill blanks / grow identity keys on an existing Candidate Master row. */
async function enrichMaster(candidateId: string, person: PersonInput, normEmail: string | null, normPhone: string | null) {
  const email = person.email ?? null
  const phone = person.phone ?? person.mobile ?? null
  const location = person.current_location ?? person.location ?? null
  const job = person.job_applied ?? person.job_title ?? null
  try {
    await query(
      `UPDATE recruitment_candidates SET
         email = COALESCE(email, ?),
         mobile = COALESCE(mobile, ?),
         norm_email = COALESCE(norm_email, ?),
         norm_phone = COALESCE(norm_phone, ?),
         current_location = COALESCE(current_location, ?),
         current_company = COALESCE(current_company, ?),
         experience = COALESCE(experience, ?),
         source = COALESCE(source, ?),
         job_applied = COALESCE(job_applied, ?),
         requisition_id = COALESCE(requisition_id, ?),
         application_id = COALESCE(?, application_id)
       WHERE candidate_id = ?`,
      [
        email, phone, normEmail, normPhone, location, person.current_company || null,
        person.experience || null, person.source || null, job, person.requisition_id || null,
        person.application_id || null, candidateId,
      ],
    )
  } catch (err) {
    if (!isMissingSchema(err)) throw err
  }
}

/**
 * Link an operational application to its canonical Candidate Master. Called
 * (best-effort) when an application is created. Sets both cross-links so the
 * two systems can navigate to each other.
 */
export async function linkApplicationToMaster(applicationId: string, person: PersonInput): Promise<string | null> {
  await ensureUnificationSchema()
  const candidateId = await resolveCandidateMaster({ ...person, application_id: applicationId })
  if (!candidateId) return null
  try {
    await query(
      "UPDATE recruit_applications SET candidate_master_id = ? WHERE application_id = ?",
      [candidateId, applicationId],
    )
    await query(
      "UPDATE recruitment_candidates SET application_id = COALESCE(application_id, ?) WHERE candidate_id = ?",
      [applicationId, candidateId],
    )
  } catch (err) {
    if (!isMissingSchema(err)) throw err
  }
  return candidateId
}

/**
 * Resolve the linking columns for a config-driven STAGE record before it is
 * inserted/updated. Given whatever the row already carries (candidate_id,
 * application_id, candidate_name, email...), fills in the missing side of the
 * candidate_id <-> application_id link so the stage record joins the unified
 * spine. Returns only the columns that should be written; empty object if the
 * table is not a linkable stage table or nothing could be resolved.
 */
export async function resolveStageLinks(
  table: string,
  record: Record<string, any>,
): Promise<Record<string, any>> {
  if (!STAGE_TABLES.includes(table as (typeof STAGE_TABLES)[number])) return {}
  await ensureUnificationSchema()

  const out: Record<string, any> = {}
  let candidateId: string | null = record.candidate_id ? String(record.candidate_id).trim() || null : null
  let applicationId: string | null = record.application_id ? String(record.application_id).trim() || null : null

  // If we have an application but no candidate, pull the master from the app.
  if (applicationId && !candidateId) {
    const rows = await safeQuery<any[]>(
      "SELECT candidate_master_id FROM recruit_applications WHERE application_id = ? LIMIT 1",
      [applicationId],
    )
    if (rows[0]?.candidate_master_id) candidateId = rows[0].candidate_master_id
  }

  // Resolve / create the canonical candidate from whatever identity we have.
  if (!candidateId) {
    candidateId = await resolveCandidateMaster({
      candidate_id: record.candidate_id,
      candidate_name: record.candidate_name,
      email: record.email,
      phone: record.mobile || record.phone,
      job_applied: record.job_applied,
      requisition_id: record.requisition_id,
    })
  }
  if (candidateId && !record.candidate_id) out.candidate_id = candidateId

  // If we have a candidate but no application, adopt the master's latest app.
  if (candidateId && !applicationId) {
    const rows = await safeQuery<any[]>(
      "SELECT application_id FROM recruitment_candidates WHERE candidate_id = ? LIMIT 1",
      [candidateId],
    )
    if (rows[0]?.application_id) applicationId = rows[0].application_id
  }
  if (applicationId) out.application_id = applicationId

  return out
}

// ---------------------------------------------------------------------------
// Unified pipeline: one row per canonical candidate, furthest stage reached
// ---------------------------------------------------------------------------
export type UnifiedStage =
  | "requisition"
  | "applied"
  | "screening"
  | "interview"
  | "feedback"
  | "selection"
  | "offer"
  | "verification"
  | "pre_joining"
  | "hired"

export const UNIFIED_STAGE_ORDER: UnifiedStage[] = [
  "applied",
  "screening",
  "interview",
  "feedback",
  "selection",
  "offer",
  "verification",
  "pre_joining",
  "hired",
]

export const UNIFIED_STAGE_LABELS: Record<UnifiedStage, string> = {
  requisition: "Requisition",
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  feedback: "Feedback",
  selection: "Selection",
  offer: "Offer",
  verification: "Verification",
  pre_joining: "Pre-Joining",
  hired: "Hired",
}

export type UnifiedCandidate = {
  candidate_id: string
  candidate_name: string
  email: string | null
  mobile: string | null
  job_applied: string | null
  application_id: string | null
  stage: UnifiedStage
  stage_label: string
  hired_employee_id: string | null
  last_activity: string | null
  counts: {
    applications: number
    screenings: number
    interviews: number
    feedback: number
    offers: number
    verifications: number
  }
}

/**
 * List every canonical candidate with the furthest stage they've reached across
 * BOTH systems. Read-only aggregate for the Candidate 360 index / unified funnel.
 */
export async function listUnifiedCandidates(searchTerm?: string): Promise<UnifiedCandidate[]> {
  await ensureUnificationSchema()

  const masters = await safeQuery<any[]>(
    `SELECT candidate_id, candidate_name, email, mobile, job_applied, application_id,
            candidate_status, requisition_id
       FROM recruitment_candidates
      ORDER BY COALESCE(application_date, created_at) DESC, id DESC
      LIMIT 3000`,
  )

  // Preload operational applications keyed by candidate_master_id + application_id.
  const apps = await safeQuery<any[]>(
    `SELECT application_id, candidate_master_id, candidate_name, email, phone, job_title,
            stage, hired_employee_id, applied_at, updated_at
       FROM recruit_applications
      ORDER BY applied_at DESC
      LIMIT 5000`,
  )
  const appByMaster = new Map<string, any[]>()
  const appById = new Map<string, any>()
  for (const a of apps) {
    appById.set(a.application_id, a)
    if (a.candidate_master_id) {
      const list = appByMaster.get(a.candidate_master_id) || []
      list.push(a)
      appByMaster.set(a.candidate_master_id, list)
    }
  }

  // Stage presence sets keyed by candidate_id and application_id.
  const stageIndex = await buildStagePresence()

  const rows: UnifiedCandidate[] = []
  for (const m of masters) {
    const cid = m.candidate_id
    const linkedApps = appByMaster.get(cid) || []
    const app = linkedApps[0] || (m.application_id ? appById.get(m.application_id) : null) || null
    const appId: string | null = app?.application_id || m.application_id || null

    const p = stageIndex.presenceFor(cid, appId)
    const status = String(m.candidate_status || "").toLowerCase()

    let stage: UnifiedStage = "applied"
    if (app?.hired_employee_id || app?.stage === "hired" || status.includes("join") || status.includes("hire")) stage = "hired"
    else if (p.preJoining) stage = "pre_joining"
    else if (p.verification) stage = "verification"
    else if (p.offer || status.includes("offer") || status.includes("select")) stage = "offer"
    else if (p.selection) stage = "selection"
    else if (p.feedback) stage = "feedback"
    else if (p.interview || app?.stage === "interview") stage = "interview"
    else if (p.screening || app?.stage === "screening" || app?.stage === "shortlisted") stage = "screening"
    else stage = "applied"

    rows.push({
      candidate_id: cid,
      candidate_name: m.candidate_name || app?.candidate_name || "—",
      email: m.email || app?.email || null,
      mobile: m.mobile || app?.phone || null,
      job_applied: m.job_applied || app?.job_title || null,
      application_id: appId,
      stage,
      stage_label: UNIFIED_STAGE_LABELS[stage],
      hired_employee_id: app?.hired_employee_id || null,
      last_activity: app?.updated_at || app?.applied_at || null,
      counts: {
        applications: linkedApps.length || (appId ? 1 : 0),
        screenings: p.screeningCount,
        interviews: p.interviewCount,
        feedback: p.feedbackCount,
        offers: p.offerCount,
        verifications: p.verificationCount,
      },
    })
  }

  const term = searchTerm?.trim().toLowerCase()
  const filtered = term
    ? rows.filter((r) =>
        [r.candidate_id, r.candidate_name, r.email, r.mobile, r.job_applied, r.application_id]
          .some((v) => String(v || "").toLowerCase().includes(term)),
      )
    : rows
  return filtered
}

/** Furthest-stage funnel counts for the whole unified pipeline. */
export async function getUnifiedFunnel(): Promise<{ stage: UnifiedStage; label: string; count: number }[]> {
  const candidates = await listUnifiedCandidates()
  const counts = new Map<UnifiedStage, number>()
  for (const s of UNIFIED_STAGE_ORDER) counts.set(s, 0)
  for (const c of candidates) counts.set(c.stage, (counts.get(c.stage) || 0) + 1)
  return UNIFIED_STAGE_ORDER.map((s) => ({ stage: s, label: UNIFIED_STAGE_LABELS[s], count: counts.get(s) || 0 }))
}

// ---------------------------------------------------------------------------
// Stage presence index (which stages each candidate/application has touched)
// ---------------------------------------------------------------------------
type Presence = {
  screening: boolean
  interview: boolean
  feedback: boolean
  selection: boolean
  offer: boolean
  verification: boolean
  preJoining: boolean
  screeningCount: number
  interviewCount: number
  feedbackCount: number
  offerCount: number
  verificationCount: number
}

async function buildStagePresence() {
  // Gather (candidate_id, application_id) touch rows from every stage source.
  const grab = async (sql: string) => safeQuery<any[]>(sql)

  const [
    scr, rInt, opInt, fb, sel, opOff, bgv, opBgv, ref, opRef, prj, opPrj,
  ] = await Promise.all([
    grab("SELECT candidate_id, application_id FROM recruitment_screening LIMIT 20000"),
    grab("SELECT candidate_id, application_id FROM recruitment_interviews LIMIT 20000"),
    grab("SELECT application_id FROM recruit_interviews LIMIT 20000"),
    grab("SELECT candidate_id, application_id FROM recruitment_interview_feedback LIMIT 20000"),
    grab("SELECT candidate_id, application_id FROM recruitment_selections LIMIT 20000"),
    grab("SELECT application_id FROM recruit_offers LIMIT 20000"),
    grab("SELECT candidate_id, application_id FROM recruitment_background_verification LIMIT 20000"),
    grab("SELECT application_id FROM recruit_bgv_checks LIMIT 20000"),
    grab("SELECT candidate_id, application_id FROM recruitment_reference_checks LIMIT 20000"),
    grab("SELECT application_id FROM recruit_reference_checks LIMIT 20000"),
    grab("SELECT candidate_id, application_id FROM recruitment_pre_joining LIMIT 20000"),
    grab("SELECT application_id FROM recruit_prejoining_tasks LIMIT 20000"),
  ])

  const byCandidate = new Map<string, Presence>()
  const byApp = new Map<string, Presence>()
  const blank = (): Presence => ({
    screening: false, interview: false, feedback: false, selection: false, offer: false,
    verification: false, preJoining: false,
    screeningCount: 0, interviewCount: 0, feedbackCount: 0, offerCount: 0, verificationCount: 0,
  })
  const touch = (map: Map<string, Presence>, key: string | null | undefined, fn: (p: Presence) => void) => {
    if (!key) return
    const k = String(key)
    let p = map.get(k)
    if (!p) { p = blank(); map.set(k, p) }
    fn(p)
  }
  const apply = (rows: any[], fn: (p: Presence) => void) => {
    for (const r of rows) {
      touch(byCandidate, r.candidate_id, fn)
      touch(byApp, r.application_id, fn)
    }
  }

  apply(scr, (p) => { p.screening = true; p.screeningCount++ })
  apply(rInt, (p) => { p.interview = true; p.interviewCount++ })
  apply(opInt, (p) => { p.interview = true; p.interviewCount++ })
  apply(fb, (p) => { p.feedback = true; p.feedbackCount++ })
  apply(sel, (p) => { p.selection = true })
  apply(opOff, (p) => { p.offer = true; p.offerCount++ })
  apply(bgv, (p) => { p.verification = true; p.verificationCount++ })
  apply(opBgv, (p) => { p.verification = true; p.verificationCount++ })
  apply(ref, (p) => { p.verification = true; p.verificationCount++ })
  apply(opRef, (p) => { p.verification = true; p.verificationCount++ })
  apply(prj, (p) => { p.preJoining = true })
  apply(opPrj, (p) => { p.preJoining = true })

  return {
    presenceFor(candidateId: string | null, applicationId: string | null): Presence {
      const a = candidateId ? byCandidate.get(String(candidateId)) : undefined
      const b = applicationId ? byApp.get(String(applicationId)) : undefined
      if (!a && !b) return blank()
      if (a && !b) return a
      if (b && !a) return b
      // Merge both.
      return {
        screening: a!.screening || b!.screening,
        interview: a!.interview || b!.interview,
        feedback: a!.feedback || b!.feedback,
        selection: a!.selection || b!.selection,
        offer: a!.offer || b!.offer,
        verification: a!.verification || b!.verification,
        preJoining: a!.preJoining || b!.preJoining,
        screeningCount: Math.max(a!.screeningCount, b!.screeningCount),
        interviewCount: a!.interviewCount + b!.interviewCount,
        feedbackCount: Math.max(a!.feedbackCount, b!.feedbackCount),
        offerCount: a!.offerCount + b!.offerCount,
        verificationCount: a!.verificationCount + b!.verificationCount,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Candidate 360: the full journey for one canonical candidate
// ---------------------------------------------------------------------------
export type TimelineEvent = {
  stage: UnifiedStage
  type: string
  title: string
  subtitle?: string | null
  status?: string | null
  date: string | null
  source: "operational" | "module"
  ref_id?: string | null
}

export type Candidate360 = {
  candidate: any | null
  applications: any[]
  requisitions: any[]
  screenings: any[]
  interviews: any[]
  feedback: any[]
  assessments: any[]
  selections: any[]
  offers: any[]
  verifications: any[]
  references: any[]
  preJoining: any[]
  employee: any | null
  timeline: TimelineEvent[]
  stage: UnifiedStage
  stage_label: string
}

export async function getCandidate360(candidateKey: string): Promise<Candidate360 | null> {
  await ensureUnificationSchema()
  const key = String(candidateKey).trim()
  if (!key) return null

  // The key may be a candidate_id (Candidate Master) or an application_id.
  let candidate =
    (await safeQuery<any[]>("SELECT * FROM recruitment_candidates WHERE candidate_id = ? LIMIT 1", [key]))[0] || null

  let candidateId: string | null = candidate?.candidate_id || null
  let appIds = new Set<string>()

  if (!candidate) {
    // Try treating the key as an application_id.
    const app = (await safeQuery<any[]>("SELECT * FROM recruit_applications WHERE application_id = ? LIMIT 1", [key]))[0]
    if (app) {
      appIds.add(app.application_id)
      if (app.candidate_master_id) {
        candidate = (await safeQuery<any[]>(
          "SELECT * FROM recruitment_candidates WHERE candidate_id = ? LIMIT 1",
          [app.candidate_master_id],
        ))[0] || null
        candidateId = candidate?.candidate_id || app.candidate_master_id
      }
    }
  }
  if (!candidate && !appIds.size) return null

  // All operational applications tied to this candidate.
  const applications = candidateId
    ? await safeQuery<any[]>(
        "SELECT * FROM recruit_applications WHERE candidate_master_id = ? OR application_id = ? ORDER BY applied_at DESC",
        [candidateId, candidate?.application_id || ""],
      )
    : await safeQuery<any[]>("SELECT * FROM recruit_applications WHERE application_id = ?", [Array.from(appIds)[0]])
  for (const a of applications) appIds.add(a.application_id)
  const appIdList = Array.from(appIds)
  const cid = candidateId || null

  // Helper to pull stage rows by candidate_id or application_id.
  const byLink = async (table: string) => {
    const conds: string[] = []
    const args: any[] = []
    if (cid) { conds.push("candidate_id = ?"); args.push(cid) }
    if (appIdList.length) { conds.push(`application_id IN (${appIdList.map(() => "?").join(",")})`); args.push(...appIdList) }
    if (!conds.length) return []
    return safeQuery<any[]>(`SELECT * FROM ${table} WHERE ${conds.join(" OR ")} ORDER BY id DESC LIMIT 500`, args)
  }
  const byApp = async (table: string) => {
    if (!appIdList.length) return []
    return safeQuery<any[]>(
      `SELECT * FROM ${table} WHERE application_id IN (${appIdList.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 500`,
      appIdList,
    )
  }

  const [
    screenings, moduleInterviews, opInterviews, feedback, assessments, selections,
    opOffers, moduleBgv, opBgv, moduleRef, opRef, modulePrj, opPrj,
  ] = await Promise.all([
    byLink("recruitment_screening"),
    byLink("recruitment_interviews"),
    byApp("recruit_interviews"),
    byLink("recruitment_interview_feedback"),
    byLink("recruitment_assessments"),
    byLink("recruitment_selections"),
    byApp("recruit_offers"),
    byLink("recruitment_background_verification"),
    byApp("recruit_bgv_checks"),
    byLink("recruitment_reference_checks"),
    byApp("recruit_reference_checks"),
    byLink("recruitment_pre_joining"),
    byApp("recruit_prejoining_tasks"),
  ])

  // Requisitions: from the master, from any linked application's job, and directly.
  const reqIds = new Set<string>()
  if (candidate?.requisition_id) reqIds.add(candidate.requisition_id)
  const jobIds = applications.map((a) => a.job_id).filter(Boolean)
  if (jobIds.length) {
    const jobs = await safeQuery<any[]>(
      `SELECT job_id, requisition_id FROM recruit_jobs WHERE job_id IN (${jobIds.map(() => "?").join(",")})`,
      jobIds,
    )
    for (const j of jobs) if (j.requisition_id) reqIds.add(j.requisition_id)
  }
  const requisitions = reqIds.size
    ? await safeQuery<any[]>(
        `SELECT * FROM recruitment_requisitions WHERE requisition_id IN (${Array.from(reqIds).map(() => "?").join(",")})`,
        Array.from(reqIds),
      )
    : []

  const interviews = [...opInterviews, ...moduleInterviews]
  const verifications = [...opBgv, ...moduleBgv]
  const references = [...opRef, ...moduleRef]
  const preJoining = [...opPrj, ...modulePrj]

  // Employee handoff (if any application converted).
  const empId = applications.find((a) => a.hired_employee_id)?.hired_employee_id || null
  const employee = empId
    ? (await safeQuery<any[]>("SELECT * FROM hr_employees WHERE employee_id = ? LIMIT 1", [empId]))[0] || null
    : null

  // ----- Build the merged timeline -----
  const timeline: TimelineEvent[] = []
  const push = (e: TimelineEvent) => timeline.push(e)

  for (const r of requisitions) push({ stage: "requisition", type: "requisition", title: `Requisition ${r.requisition_id}`, subtitle: r.job_title, status: r.status, date: r.requisition_date || null, source: "module", ref_id: r.requisition_id })
  for (const a of applications) push({ stage: "applied", type: "application", title: `Applied — ${a.job_title || "role"}`, subtitle: a.source, status: a.stage, date: a.applied_at || null, source: "operational", ref_id: a.application_id })
  for (const s of screenings) push({ stage: "screening", type: "screening", title: `Screening`, subtitle: s.recruiter, status: s.screening_result || s.status, date: s.screening_date || null, source: "module", ref_id: s.screening_id })
  for (const i of moduleInterviews) push({ stage: "interview", type: "interview", title: `${i.interview_round || "Interview"}`, subtitle: i.interviewer, status: i.interview_result, date: i.interview_date || null, source: "module", ref_id: i.interview_id })
  for (const i of opInterviews) push({ stage: "interview", type: "interview", title: `${i.round || "Interview"}`, subtitle: i.interviewer, status: i.status, date: i.scheduled_at || null, source: "operational", ref_id: i.interview_id })
  for (const f of feedback) push({ stage: "feedback", type: "feedback", title: `Feedback — ${f.interviewer || ""}`, subtitle: f.recommendation, status: f.final_result, date: f.feedback_date || null, source: "module", ref_id: f.feedback_id })
  for (const a of assessments) push({ stage: "feedback", type: "assessment", title: `Assessment`, subtitle: a.assessment_type, status: a.status, date: a.assessment_sent_date || null, source: "module", ref_id: a.assessment_id })
  for (const s of selections) push({ stage: "selection", type: "selection", title: `Selection`, subtitle: s.employment_type, status: s.offer_status || s.joining_status, date: s.selection_date || null, source: "module", ref_id: s.selection_id })
  for (const o of opOffers) push({ stage: "offer", type: "offer", title: `Offer — ${o.job_title || ""}`, subtitle: o.salary ? `${o.currency || ""} ${o.salary}` : null, status: o.status, date: o.created_at || null, source: "operational", ref_id: o.offer_id })
  for (const v of moduleBgv) push({ stage: "verification", type: "bgv", title: `BGV — ${v.check_type || ""}`, subtitle: v.vendor_name, status: v.status, date: v.initiated_date || null, source: "module", ref_id: v.bgv_id })
  for (const v of opBgv) push({ stage: "verification", type: "bgv", title: `BGV — ${v.check_type || ""}`, subtitle: v.agency, status: v.status, date: v.initiated_at || null, source: "operational", ref_id: v.bgv_id })
  for (const r of moduleRef) push({ stage: "verification", type: "reference", title: `Reference — ${r.reference_name || ""}`, subtitle: r.reference_company, status: r.result, date: r.check_date || null, source: "module", ref_id: r.reference_id })
  for (const r of opRef) push({ stage: "verification", type: "reference", title: `Reference — ${r.referee_name || ""}`, subtitle: r.company, status: r.status, date: r.checked_at || null, source: "operational", ref_id: r.reference_id })
  for (const p of modulePrj) push({ stage: "pre_joining", type: "pre_joining", title: `Pre-Joining`, subtitle: p.coordinator, status: p.status, date: p.expected_joining_date || null, source: "module", ref_id: p.prejoin_id })
  for (const p of opPrj) push({ stage: "pre_joining", type: "pre_joining", title: `Pre-Joining — ${p.task || ""}`, subtitle: p.owner, status: p.status, date: p.due_date || null, source: "operational", ref_id: p.task_id })
  if (employee) push({ stage: "hired", type: "employee", title: `Hired — ${employee.employee_id}`, subtitle: employee.designation, status: employee.employment_status, date: employee.joining_date || null, source: "operational", ref_id: employee.employee_id })

  timeline.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))

  // Furthest stage reached.
  const reached = new Set<UnifiedStage>()
  for (const e of timeline) reached.add(e.stage)
  let stage: UnifiedStage = "applied"
  for (const s of UNIFIED_STAGE_ORDER) if (reached.has(s)) stage = s

  return {
    candidate,
    applications,
    requisitions,
    screenings,
    interviews,
    feedback,
    assessments,
    selections,
    offers: opOffers,
    verifications,
    references,
    preJoining,
    employee,
    timeline,
    stage,
    stage_label: UNIFIED_STAGE_LABELS[stage],
  }
}

// ---------------------------------------------------------------------------
// One-time backfill: link existing applications + stage rows into the spine
// ---------------------------------------------------------------------------
export async function backfillUnification(): Promise<{ applicationsLinked: number; stageRowsLinked: number }> {
  await ensureUnificationSchema()

  // 1. Link every operational application to a Candidate Master.
  const apps = await safeQuery<any[]>(
    `SELECT application_id, candidate_name, email, phone, location, current_company, experience,
            job_title, source, applied_at, candidate_master_id
       FROM recruit_applications
      ORDER BY applied_at ASC
      LIMIT 10000`,
  )
  let applicationsLinked = 0
  for (const a of apps) {
    if (a.candidate_master_id) continue
    const cid = await linkApplicationToMaster(a.application_id, {
      candidate_name: a.candidate_name,
      email: a.email,
      phone: a.phone,
      location: a.location,
      current_company: a.current_company,
      experience: a.experience,
      job_title: a.job_title,
      source: a.source,
      applied_at: a.applied_at,
    })
    if (cid) applicationsLinked++
  }

  // 2. Stamp application_id onto config stage rows that only carry candidate_id.
  let stageRowsLinked = 0
  for (const table of STAGE_TABLES) {
    const rows = await safeQuery<any[]>(
      `SELECT id, candidate_id, candidate_name, application_id FROM ${table}
        WHERE (application_id IS NULL OR application_id = '') LIMIT 10000`,
    )
    for (const r of rows) {
      const links = await resolveStageLinks(table, r)
      const cols = Object.keys(links)
      if (!cols.length) continue
      try {
        await query(
          `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`,
          [...cols.map((c) => links[c]), r.id],
        )
        stageRowsLinked++
      } catch (err) {
        if (!isMissingSchema(err)) throw err
      }
    }
  }

  return { applicationsLinked, stageRowsLinked }
}
