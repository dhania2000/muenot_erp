import "server-only"
import { query } from "@/lib/db"
import { nextRecordIdForPrefix } from "@/lib/settings/numbering"
import {
  normalizeStage,
  stageRank,
  isTerminalStage,
  screeningResultToStage,
  assessmentResultToStage,
  interviewResultToStage,
  selectionResultToStage,
  feedbackResultToStage,
  type CanonicalStage,
} from "@/lib/recruitment-stages"

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
    "ALTER TABLE recruit_applications ADD COLUMN IF NOT EXISTS requisition_id VARCHAR(40) DEFAULT NULL",
    "ALTER TABLE recruit_applications ADD COLUMN IF NOT EXISTS campaign VARCHAR(190) DEFAULT NULL",
    "ALTER TABLE recruit_applications ADD COLUMN IF NOT EXISTS recruiter VARCHAR(190) DEFAULT NULL",
    "ALTER TABLE recruit_applications ADD INDEX IF NOT EXISTS idx_app_requisition (requisition_id)",
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
    // Phase 14: Assessment links up to the Requisition -> Job spine.
    "ALTER TABLE recruitment_assessments ADD COLUMN IF NOT EXISTS requisition_id VARCHAR(40) DEFAULT NULL",
    "ALTER TABLE recruitment_assessments ADD COLUMN IF NOT EXISTS job_id VARCHAR(40) DEFAULT NULL",
    // Phase 15: unified interview record carries panel + explicit mode + job link.
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS panel VARCHAR(512) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS interview_mode VARCHAR(64) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS job_id VARCHAR(40) DEFAULT NULL",
    // Phase 19: full evaluation criteria on the panel feedback record.
    "ALTER TABLE recruitment_interview_feedback ADD COLUMN IF NOT EXISTS domain_knowledge_score DECIMAL(18,2) DEFAULT NULL",
    "ALTER TABLE recruitment_interview_feedback ADD COLUMN IF NOT EXISTS problem_solving_score DECIMAL(18,2) DEFAULT NULL",
    // Phase 31: Talent Pool is a CURATED SUBSET of the Candidate Master — a set
    // of flags on the canonical person, never a duplicate candidate store.
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS in_talent_pool TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS talent_pool_status VARCHAR(60) DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS talent_pool_role VARCHAR(190) DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS talent_pool_owner VARCHAR(190) DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS talent_pool_next_contact DATE DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS talent_pool_notes TEXT DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD COLUMN IF NOT EXISTS talent_pool_added_at DATETIME DEFAULT NULL",
    "ALTER TABLE recruitment_candidates ADD INDEX IF NOT EXISTS idx_cand_talent_pool (in_talent_pool)",
    // Phase 37/38: calls link back to the canonical candidate + job so a logged
    // call resolves to the spine even when placed from the aggregate dialer.
    "ALTER TABLE recruit_calls ADD COLUMN IF NOT EXISTS candidate_master_id VARCHAR(191) DEFAULT NULL",
    "ALTER TABLE recruit_calls ADD COLUMN IF NOT EXISTS job_id VARCHAR(40) DEFAULT NULL",
    // Phase 32/40: referrals + follow-ups join the pipeline via application_id.
    "ALTER TABLE recruitment_referrals ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL",
    "ALTER TABLE recruitment_followups ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL",
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
// Stage write-back (Phases 12-15): saving a stage record moves the linked
// operational application through the ONE canonical pipeline.
// ---------------------------------------------------------------------------

/**
 * Advance an application to `target` following the canonical stage rules:
 *  - a hired application is final and never changes,
 *  - an existing terminal state (rejected/hold/withdrawn) is never overwritten
 *    by a forward-progression stage,
 *  - forward progression only ever moves forward (a later screening "On Hold"
 *    can't drag a candidate already at Interview backwards),
 *  - terminal targets can be applied from any non-hired state.
 * Returns true when the row's stage actually changed.
 */
export async function advanceApplicationStage(
  applicationId: string | null | undefined,
  target: CanonicalStage | null,
): Promise<boolean> {
  if (!applicationId || !target) return false
  await ensureUnificationSchema()
  const rows = await safeQuery<any[]>(
    "SELECT stage FROM recruit_applications WHERE application_id = ? LIMIT 1",
    [applicationId],
  )
  if (!rows[0]) return false
  const current = normalizeStage(rows[0].stage)
  if (current === "hired") return false
  if (isTerminalStage(current) && !isTerminalStage(target)) return false
  if (isTerminalStage(target)) {
    if (current === target) return false
  } else if (stageRank(target) <= stageRank(current)) {
    return false
  }
  try {
    await query("UPDATE recruit_applications SET stage = ? WHERE application_id = ?", [target, applicationId])
    return true
  } catch (err) {
    if (isMissingSchema(err)) return false
    throw err
  }
}

/**
 * After a config-driven stage record is created/updated, push its outcome onto
 * the linked application so the operational pipeline stays in lock-step with
 * Screening / Assessment / Interview / Selection.
 */
export async function applyStageWriteBack(table: string, record: Record<string, any>): Promise<boolean> {
  try {
    let appId: string | null = record.application_id ? String(record.application_id).trim() || null : null
    if (!appId) {
      const links = await resolveStageLinks(table, record)
      appId = links.application_id ? String(links.application_id) : null
    }
    if (!appId) return false

    let target: CanonicalStage | null = null
    switch (table) {
      case "recruitment_screening":
        target = screeningResultToStage(record.screening_result)
        break
      case "recruitment_assessments":
        target = assessmentResultToStage(record.assessment_result)
        break
      case "recruitment_interviews":
        target = interviewResultToStage(record.interview_result)
        break
      case "recruitment_selections":
        target = selectionResultToStage(record)
        break
      case "recruitment_interview_feedback":
        target = feedbackResultToStage(record)
        break
      default:
        return false
    }
    return await advanceApplicationStage(appId, target)
  } catch (err) {
    if (isMissingSchema(err)) return false
    throw err
  }
}

// ---------------------------------------------------------------------------
// Phase 13: shortlisting actions on real Application records.
// ---------------------------------------------------------------------------
export type BulkApplicationAction = "shortlist" | "reject" | "hold" | "advance"

export type BulkActionResult = { updated: number; skipped: number; total: number }

/**
 * Apply a shortlist-style action to one or many applications. Operates on the
 * real recruit_applications rows (never a detached copy) and, for shortlisting,
 * writes a single canonical Screening record per application — re-running the
 * action never creates a duplicate shortlist row.
 */
export async function bulkApplicationAction(
  action: BulkApplicationAction,
  applicationIds: string[],
  opts: { targetStage?: string; recruiter?: string | null; userId?: number | null } = {},
): Promise<BulkActionResult> {
  await ensureUnificationSchema()
  const ids = Array.from(new Set((applicationIds || []).map((s) => String(s).trim()).filter(Boolean)))
  const result: BulkActionResult = { updated: 0, skipped: 0, total: ids.length }

  const target: CanonicalStage | null =
    action === "shortlist"
      ? "shortlisted"
      : action === "reject"
        ? "rejected"
        : action === "hold"
          ? "hold"
          : opts.targetStage
            ? normalizeStage(opts.targetStage)
            : null

  for (const appId of ids) {
    let changed = await advanceApplicationStage(appId, target)
    if (action === "shortlist") {
      // Attach exactly one Screening record marking the shortlist decision.
      const created = await ensureShortlistScreening(appId, opts)
      changed = changed || created
    }
    if (changed) result.updated++
    else result.skipped++
  }
  return result
}

/** Create a Shortlisted screening row for an application only if none exists. */
async function ensureShortlistScreening(
  applicationId: string,
  opts: { recruiter?: string | null; userId?: number | null },
): Promise<boolean> {
  try {
    const existing = await safeQuery<any[]>(
      "SELECT id FROM recruitment_screening WHERE application_id = ? LIMIT 1",
      [applicationId],
    )
    if (existing.length > 0) return false

    const app = await safeQuery<any[]>(
      `SELECT application_id, candidate_master_id, candidate_name, email, phone, job_title, requisition_id
         FROM recruit_applications WHERE application_id = ? LIMIT 1`,
      [applicationId],
    )
    if (!app[0]) return false
    const a = app[0]

    const screeningId = await nextRecordIdForPrefix("SCR")
    await query(
      `INSERT INTO recruitment_screening
        (screening_id, candidate_id, application_id, candidate_name, email, job_applied,
         requisition_id, screening_result, recruiter, screening_date)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        screeningId,
        a.candidate_master_id || null,
        applicationId,
        a.candidate_name || null,
        a.email || null,
        a.job_title || null,
        a.requisition_id || null,
        "Shortlisted",
        opts.recruiter || null,
        new Date(),
      ],
    )
    return true
  } catch (err) {
    if (isMissingSchema(err)) return false
    throw err
  }
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

// ---------------------------------------------------------------------------
// Candidate Database (single source): the canonical Candidate Master, enriched
// with live application stats. Replaces the old parallel recruit_candidates
// profile store — every real person appears exactly once, keyed on candidate_id.
// ---------------------------------------------------------------------------
export type CandidateDbRow = {
  candidate_id: string | null
  candidate_name: string
  email: string | null
  phone: string | null
  location: string | null
  current_company: string | null
  experience: string | null
  applications_count: number
  jobs: string | null
  rating: number
  last_applied: string | null
}

export async function listCandidateDatabase(): Promise<CandidateDbRow[]> {
  await ensureUnificationSchema()

  const masters = await safeQuery<any[]>(
    `SELECT candidate_id, candidate_name, email, mobile, norm_email, norm_phone,
            current_location, current_company, experience, job_applied, application_id,
            application_date, created_at
       FROM recruitment_candidates
      LIMIT 5000`,
  )
  const apps = await safeQuery<any[]>(
    `SELECT application_id, candidate_master_id, candidate_name, email, phone, location,
            current_company, experience, job_title, rating, applied_at
       FROM recruit_applications
      ORDER BY applied_at DESC
      LIMIT 10000`,
  )

  // Attach applications to their Candidate Master — first by the explicit
  // candidate_master_id link, then (for not-yet-linked rows) by normalized
  // identity. Anything still unmatched is an orphan grouped separately so no
  // real person silently disappears before the backfill runs.
  const appsByMaster = new Map<string, any[]>()
  const masterByEmail = new Map<string, any>()
  const masterByPhone = new Map<string, any>()
  for (const m of masters) {
    if (m.norm_email && !masterByEmail.has(m.norm_email)) masterByEmail.set(m.norm_email, m)
    if (m.norm_phone && !masterByPhone.has(m.norm_phone)) masterByPhone.set(m.norm_phone, m)
  }
  const pushApp = (cid: string, a: any) => {
    const l = appsByMaster.get(cid) || []
    l.push(a)
    appsByMaster.set(cid, l)
  }
  const orphanApps: any[] = []
  for (const a of apps) {
    if (a.candidate_master_id) {
      pushApp(a.candidate_master_id, a)
      continue
    }
    const m =
      (normalizeEmail(a.email) && masterByEmail.get(normalizeEmail(a.email)!)) ||
      (normalizePhone(a.phone) && masterByPhone.get(normalizePhone(a.phone)!)) ||
      null
    if (m) pushApp(m.candidate_id, a)
    else orphanApps.push(a)
  }

  const rows: CandidateDbRow[] = []
  for (const m of masters) {
    const linked = appsByMaster.get(m.candidate_id) || []
    const jobs = new Set<string>()
    if (m.job_applied) jobs.add(m.job_applied)
    let rating = 0
    let lastApplied: string | null = m.application_date ? String(m.application_date) : m.created_at ? String(m.created_at) : null
    for (const a of linked) {
      if (a.job_title) jobs.add(a.job_title)
      rating = Math.max(rating, Number(a.rating) || 0)
      const ts = a.applied_at ? String(a.applied_at) : null
      if (ts && (!lastApplied || ts > lastApplied)) lastApplied = ts
    }
    rows.push({
      candidate_id: m.candidate_id,
      candidate_name: m.candidate_name || linked[0]?.candidate_name || "—",
      email: m.email || linked[0]?.email || null,
      phone: m.mobile || linked[0]?.phone || null,
      location: m.current_location || linked[0]?.location || null,
      current_company: m.current_company || linked[0]?.current_company || null,
      experience: m.experience || linked[0]?.experience || null,
      applications_count: linked.length,
      jobs: jobs.size ? Array.from(jobs).join(", ") : null,
      rating,
      last_applied: lastApplied,
    })
  }

  if (orphanApps.length) rows.push(...groupOrphanApplications(orphanApps))

  return rows.sort((a, b) => String(b.last_applied || "").localeCompare(String(a.last_applied || "")))
}

/** Fold orphan applications (no Candidate Master yet) into one row per person. */
function groupOrphanApplications(apps: any[]): CandidateDbRow[] {
  const parent = apps.map((_, i) => i)
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
  apps.forEach((a, i) => {
    const e = normalizeEmail(a.email)
    if (e) {
      const prev = emailOwner.get(e)
      if (prev === undefined) emailOwner.set(e, i)
      else union(prev, i)
    }
    const p = normalizePhone(a.phone)
    if (p) {
      const prev = phoneOwner.get(p)
      if (prev === undefined) phoneOwner.set(p, i)
      else union(prev, i)
    }
  })

  const groups = new Map<number, CandidateDbRow & { _jobs: Set<string> }>()
  for (let i = 0; i < apps.length; i++) {
    const a = apps[i]
    const root = find(i)
    let g = groups.get(root)
    if (!g) {
      g = {
        candidate_id: null,
        candidate_name: a.candidate_name || "—",
        email: a.email || null,
        phone: a.phone || null,
        location: a.location || null,
        current_company: a.current_company || null,
        experience: a.experience || null,
        applications_count: 0,
        jobs: null,
        rating: 0,
        last_applied: a.applied_at ? String(a.applied_at) : null,
        _jobs: new Set<string>(),
      }
      groups.set(root, g)
    }
    g.applications_count += 1
    if (!g.candidate_name || g.candidate_name === "—") g.candidate_name = a.candidate_name || g.candidate_name
    if (!g.email && a.email) g.email = a.email
    if (!g.phone && a.phone) g.phone = a.phone
    if (!g.location && a.location) g.location = a.location
    if (!g.current_company && a.current_company) g.current_company = a.current_company
    if (!g.experience && a.experience) g.experience = a.experience
    if (a.job_title) g._jobs.add(a.job_title)
    g.rating = Math.max(g.rating, Number(a.rating) || 0)
    const ts = a.applied_at ? String(a.applied_at) : null
    if (ts && (!g.last_applied || ts > g.last_applied)) g.last_applied = ts
  }

  return Array.from(groups.values()).map(({ _jobs, ...rest }) => ({
    ...rest,
    jobs: _jobs.size ? Array.from(_jobs).join(", ") : null,
  }))
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

// ===========================================================================
// Phase 38/39: Candidate Activities as the ONE central candidate timeline.
//
// Every meaningful pipeline event (application, screening, shortlist,
// assessment, interview, feedback, offer, call, follow-up, document, BGV,
// reference, pre-joining, joining, status change) is recorded exactly ONCE into
// recruitment_candidate_activities, keyed by (source_type, source_ref) so it is
// idempotent — re-saving a source record updates the same activity instead of
// creating a duplicate.
// ===========================================================================

export type ActivityInput = {
  candidate_id?: string | null
  candidate_master_id?: string | null
  application_id?: string | null
  candidate_name?: string | null
  job_applied?: string | null
  requisition_id?: string | null
  email?: string | null
  phone?: string | null
  activity_type: string
  activity_date?: string | Date | null
  performed_by?: string | null
  subject?: string | null
  notes?: string | null
  outcome?: string | null
  next_action?: string | null
  next_action_date?: string | Date | null
  /** Stable identity of the originating record, for idempotency. */
  source_type?: string | null
  source_ref?: string | null
  created_by?: number | null
}

let activitySchemaEnsured = false
/** Create/patch the activity timeline table. Best-effort + idempotent. */
async function ensureActivitySchema() {
  if (activitySchemaEnsured) return
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS recruitment_candidate_activities (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         activity_id VARCHAR(191) NULL,
         activity_date DATE NULL,
         activity_type VARCHAR(512) NULL,
         performed_by VARCHAR(512) NULL,
         candidate_id VARCHAR(512) NULL,
         candidate_name VARCHAR(512) NULL,
         job_applied VARCHAR(512) NULL,
         requisition_id VARCHAR(512) NULL,
         subject VARCHAR(512) NULL,
         notes TEXT NULL,
         outcome VARCHAR(512) NULL,
         next_action VARCHAR(512) NULL,
         next_action_date DATE NULL,
         created_by BIGINT UNSIGNED NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uq_recruitment_candidate_activities_bizid (activity_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    )
  } catch {
    // Table already exists in a different shape — the alters below reconcile it.
  }
  const alters = [
    "ALTER TABLE recruitment_candidate_activities ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL",
    "ALTER TABLE recruitment_candidate_activities ADD COLUMN IF NOT EXISTS source_type VARCHAR(60) DEFAULT NULL",
    "ALTER TABLE recruitment_candidate_activities ADD COLUMN IF NOT EXISTS source_ref VARCHAR(191) DEFAULT NULL",
    "ALTER TABLE recruitment_candidate_activities ADD INDEX IF NOT EXISTS idx_act_candidate (candidate_id)",
    "ALTER TABLE recruitment_candidate_activities ADD INDEX IF NOT EXISTS idx_act_app (application_id)",
    // Multiple NULLs are allowed in a MySQL UNIQUE key, so manual (source-less)
    // activities never collide — only auto-recorded source rows are deduped.
    "ALTER TABLE recruitment_candidate_activities ADD UNIQUE KEY uq_act_source (source_type, source_ref)",
  ]
  for (const sql of alters) {
    try {
      await query(sql)
    } catch {
      // already present
    }
  }
  activitySchemaEnsured = true
}

function toDateOnly(d: string | Date | null | undefined): string | null {
  if (!d) return null
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return typeof d === "string" ? d.slice(0, 10) : null
  return dt.toISOString().slice(0, 10)
}

/**
 * Record (or update) a single activity on the central candidate timeline.
 * Resolves the canonical candidate from whatever identity is available
 * (explicit id, application, email/phone). Best-effort: never throws, so it can
 * be called from any create/update path without risking the primary write.
 * Returns true when a NEW activity row was inserted.
 */
export async function recordCandidateActivity(input: ActivityInput): Promise<boolean> {
  try {
    await ensureUnificationSchema()
    await ensureActivitySchema()

    let candidateId =
      String(input.candidate_master_id || input.candidate_id || "").trim() || null
    let applicationId = input.application_id ? String(input.application_id).trim() || null : null

    if (applicationId && !candidateId) {
      const rows = await safeQuery<any[]>(
        "SELECT candidate_master_id FROM recruit_applications WHERE application_id = ? LIMIT 1",
        [applicationId],
      )
      if (rows[0]?.candidate_master_id) candidateId = rows[0].candidate_master_id
    }

    // Resolve by normalized phone (calls placed from the aggregate dialer only
    // know the number) before falling back to full resolution.
    if (!candidateId && input.phone) {
      const np = normalizePhone(input.phone)
      if (np) {
        const rows = await safeQuery<any[]>(
          "SELECT candidate_id FROM recruitment_candidates WHERE norm_phone = ? ORDER BY id ASC LIMIT 1",
          [np],
        )
        if (rows[0]?.candidate_id) candidateId = rows[0].candidate_id
      }
    }

    if (!candidateId && (input.email || input.phone || input.candidate_name)) {
      candidateId = await resolveCandidateMaster({
        candidate_id: input.candidate_id,
        candidate_name: input.candidate_name,
        email: input.email,
        phone: input.phone,
        job_applied: input.job_applied,
        requisition_id: input.requisition_id,
        application_id: applicationId,
      })
    }

    // Without any anchor there is nothing to hang the activity on.
    if (!candidateId && !applicationId) return false

    if (applicationId && !candidateId) {
      const rows = await safeQuery<any[]>(
        "SELECT candidate_master_id FROM recruit_applications WHERE application_id = ? LIMIT 1",
        [applicationId],
      )
      if (rows[0]?.candidate_master_id) candidateId = rows[0].candidate_master_id
    }

    const activityDate = toDateOnly(input.activity_date) || toDateOnly(new Date())
    const nextActionDate = toDateOnly(input.next_action_date)

    // Idempotency: one activity per source record.
    if (input.source_type && input.source_ref) {
      const existing = await safeQuery<any[]>(
        "SELECT id FROM recruitment_candidate_activities WHERE source_type = ? AND source_ref = ? LIMIT 1",
        [input.source_type, input.source_ref],
      )
      if (existing[0]) {
        await query(
          `UPDATE recruitment_candidate_activities SET
             activity_type = ?, activity_date = ?, performed_by = COALESCE(?, performed_by),
             subject = ?, notes = ?, outcome = ?,
             next_action = COALESCE(?, next_action), next_action_date = COALESCE(?, next_action_date),
             candidate_id = COALESCE(candidate_id, ?), candidate_name = COALESCE(candidate_name, ?),
             job_applied = COALESCE(job_applied, ?), application_id = COALESCE(application_id, ?)
           WHERE source_type = ? AND source_ref = ?`,
          [
            input.activity_type, activityDate, input.performed_by || null,
            input.subject || null, input.notes || null, input.outcome || null,
            input.next_action || null, nextActionDate,
            candidateId, input.candidate_name || null, input.job_applied || null, applicationId,
            input.source_type, input.source_ref,
          ],
        )
        return false
      }
    }

    const activityId = await nextRecordIdForPrefix("ACT")
    await query(
      `INSERT INTO recruitment_candidate_activities
        (activity_id, activity_date, activity_type, performed_by, candidate_id, candidate_name,
         job_applied, requisition_id, subject, notes, outcome, next_action, next_action_date,
         application_id, source_type, source_ref, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        activityId, activityDate, input.activity_type, input.performed_by || null,
        candidateId, input.candidate_name || null, input.job_applied || null,
        input.requisition_id || null, input.subject || null, input.notes || null,
        input.outcome || null, input.next_action || null, nextActionDate,
        applicationId, input.source_type || null, input.source_ref || null, input.created_by ?? null,
      ],
    )
    return true
  } catch {
    // Timeline recording must never break the primary write.
    return false
  }
}

// Map a config-driven module table to how it appears on the central timeline.
type ModuleActivitySpec = {
  activity_type: string
  source_type: string
  idColumn: string
  subject?: (r: Record<string, any>) => string | null
  outcome?: (r: Record<string, any>) => string | null
  date?: (r: Record<string, any>) => any
}

const MODULE_ACTIVITY_MAP: Record<string, ModuleActivitySpec> = {
  recruitment_screening: {
    activity_type: "Screening", source_type: "screening", idColumn: "screening_id",
    subject: (r) => r.recruiter ? `Screened by ${r.recruiter}` : "Screening",
    outcome: (r) => r.screening_result || r.status || null,
    date: (r) => r.screening_date,
  },
  recruitment_assessments: {
    activity_type: "Assessment", source_type: "assessment", idColumn: "assessment_id",
    subject: (r) => r.assessment_type ? `Assessment — ${r.assessment_type}` : "Assessment",
    outcome: (r) => r.assessment_result || r.status || null,
    date: (r) => r.assessment_sent_date,
  },
  recruitment_interviews: {
    activity_type: "Interview", source_type: "interview", idColumn: "interview_id",
    subject: (r) => r.interview_round || "Interview",
    outcome: (r) => r.interview_result || r.attendance || null,
    date: (r) => r.interview_date,
  },
  recruitment_interview_feedback: {
    activity_type: "Feedback", source_type: "feedback", idColumn: "feedback_id",
    subject: (r) => r.interviewer ? `Feedback — ${r.interviewer}` : "Interview feedback",
    outcome: (r) => r.recommendation || r.final_result || null,
    date: (r) => r.feedback_date,
  },
  recruitment_selections: {
    activity_type: "Offer", source_type: "selection", idColumn: "selection_id",
    subject: (r) => "Selection / Offer",
    outcome: (r) => r.offer_status || r.joining_status || null,
    date: (r) => r.selection_date,
  },
  recruitment_background_verification: {
    activity_type: "BGV", source_type: "bgv", idColumn: "bgv_id",
    subject: (r) => r.check_type ? `BGV — ${r.check_type}` : "Background verification",
    outcome: (r) => r.result || r.status || null,
    date: (r) => r.initiated_date,
  },
  recruitment_reference_checks: {
    activity_type: "Reference", source_type: "reference", idColumn: "reference_id",
    subject: (r) => r.reference_name ? `Reference — ${r.reference_name}` : "Reference check",
    outcome: (r) => r.result || r.status || null,
    date: (r) => r.check_date,
  },
  recruitment_pre_joining: {
    activity_type: "Pre-Joining", source_type: "pre_joining", idColumn: "prejoin_id",
    subject: (r) => "Pre-joining",
    outcome: (r) => r.status || null,
    date: (r) => r.expected_joining_date,
  },
  recruitment_candidate_documents: {
    activity_type: "Document", source_type: "document", idColumn: "document_id",
    subject: (r) => r.document_name || r.document_type || "Document",
    outcome: (r) => r.verification_status || null,
    date: (r) => r.received_date,
  },
  recruitment_followups: {
    activity_type: "Follow-up", source_type: "followup", idColumn: "followup_id",
    subject: (r) => r.followup_type ? `Follow-up — ${r.followup_type}` : "Follow-up",
    outcome: (r) => r.status || null,
    date: (r) => r.last_contact_date || r.next_followup_date,
  },
  recruitment_tasks: {
    activity_type: "Task", source_type: "task", idColumn: "task_id",
    subject: (r) => r.task_title || (r.task_type ? `Task — ${r.task_type}` : "Task"),
    outcome: (r) => r.status || null,
    date: (r) => r.due_date || r.start_date,
  },
}

/**
 * Auto-record a config-driven module record onto the central timeline. Called
 * (best-effort) after a create/update in the recruitment CRUD factory. Only the
 * tables in MODULE_ACTIVITY_MAP produce an activity; everything else is a no-op.
 */
export async function recordActivityForModule(
  table: string,
  record: Record<string, any>,
  userId: number | null,
): Promise<void> {
  const spec = MODULE_ACTIVITY_MAP[table]
  if (!spec) return
  const sourceRef = record[spec.idColumn] ? String(record[spec.idColumn]) : null
  if (!sourceRef) return
  await recordCandidateActivity({
    candidate_id: record.candidate_id,
    application_id: record.application_id,
    candidate_name: record.candidate_name,
    job_applied: record.job_applied || record.job_title,
    requisition_id: record.requisition_id,
    email: record.email,
    phone: record.mobile || record.phone,
    activity_type: spec.activity_type,
    activity_date: spec.date ? spec.date(record) : null,
    performed_by: record.recruiter || record.interviewer || record.owner || record.performed_by || null,
    subject: spec.subject ? spec.subject(record) : null,
    outcome: spec.outcome ? spec.outcome(record) : null,
    next_action: record.next_action || null,
    next_action_date: record.next_followup_date || record.next_action_date || null,
    source_type: spec.source_type,
    source_ref: sourceRef,
    created_by: userId,
  })
}

// ===========================================================================
// Phase 32/40: link a non-stage module record (referral / follow-up) to the
// canonical candidate + latest application so it joins the ONE pipeline.
// ===========================================================================
const NON_STAGE_LINK_TABLES = new Set([
  "recruitment_referrals",
  "recruitment_followups",
  "recruitment_tasks",
  "recruitment_costs",
])

export async function resolveNonStageLinks(
  table: string,
  record: Record<string, any>,
): Promise<Record<string, any>> {
  if (!NON_STAGE_LINK_TABLES.has(table)) return {}
  await ensureUnificationSchema()
  const out: Record<string, any> = {}

  let candidateId = record.candidate_id ? String(record.candidate_id).trim() || null : null
  let applicationId = record.application_id ? String(record.application_id).trim() || null : null

  if (!candidateId) {
    candidateId = await resolveCandidateMaster({
      candidate_id: record.candidate_id,
      candidate_name: record.candidate_name,
      email: record.candidate_email || record.email,
      phone: record.candidate_mobile || record.mobile || record.phone,
      job_applied: record.job_title,
      requisition_id: record.requisition_id,
    })
    if (candidateId) out.candidate_id = candidateId
  }
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

// ===========================================================================
// Phase 31: Talent Pool — a curated view over the Candidate Master (flags), not
// a separate candidate store. Moving a Candidate Database person into the pool
// just sets their flags; it never copies the person.
// ===========================================================================
export const TALENT_POOL_STATUSES = [
  "Active",
  "Available",
  "Passive",
  "Future Opportunity",
  "Rejected but Reusable",
  "Hired",
] as const

export type TalentPoolInput = {
  candidate_id?: string | null
  candidate_name?: string | null
  email?: string | null
  mobile?: string | null
  pool_status?: string | null
  preferred_role?: string | null
  owner?: string | null
  next_contact_date?: string | null
  notes?: string | null
  added_date?: string | null
  in_pool?: boolean
}

/** Add / update / remove a candidate in the Talent Pool by flipping flags on
 *  their canonical Candidate Master row. Resolves (or creates) the person from
 *  whatever identity is supplied. Returns the candidate_id touched. */
export async function setCandidateTalentPool(input: TalentPoolInput): Promise<string | null> {
  await ensureUnificationSchema()
  const candidateId = await resolveCandidateMaster({
    candidate_id: input.candidate_id,
    candidate_name: input.candidate_name,
    email: input.email,
    phone: input.mobile,
  })
  if (!candidateId) return null

  const inPool = input.in_pool === false ? 0 : 1
  const status =
    input.pool_status && (TALENT_POOL_STATUSES as readonly string[]).includes(input.pool_status)
      ? input.pool_status
      : "Available"
  try {
    await query(
      `UPDATE recruitment_candidates SET
         in_talent_pool = ?,
         talent_pool_status = ?,
         talent_pool_role = COALESCE(?, talent_pool_role),
         talent_pool_owner = COALESCE(?, talent_pool_owner),
         talent_pool_next_contact = COALESCE(?, talent_pool_next_contact),
         talent_pool_notes = COALESCE(?, talent_pool_notes),
         talent_pool_added_at = COALESCE(talent_pool_added_at, ?)
       WHERE candidate_id = ?`,
      [
        inPool,
        inPool ? status : null,
        input.preferred_role || null,
        input.owner || null,
        input.next_contact_date || null,
        input.notes || null,
        input.added_date ? new Date(input.added_date) : new Date(),
        candidateId,
      ],
    )
  } catch (err) {
    if (!isMissingSchema(err)) throw err
  }
  return candidateId
}

export async function listTalentPool(searchTerm?: string): Promise<any[]> {
  await ensureUnificationSchema()
  const rows = await safeQuery<any[]>(
    `SELECT candidate_id, candidate_name, email, mobile, current_location, experience,
            job_applied, source, talent_pool_status, talent_pool_role, talent_pool_owner,
            talent_pool_next_contact, talent_pool_notes, talent_pool_added_at
       FROM recruitment_candidates
      WHERE in_talent_pool = 1
      ORDER BY talent_pool_added_at DESC, id DESC
      LIMIT 5000`,
  )
  const term = searchTerm?.trim().toLowerCase()
  const mapped = rows.map((m) => ({
    // Present the Candidate Master flags through the Talent Pool module columns.
    pool_id: m.candidate_id,
    candidate_id: m.candidate_id,
    added_date: m.talent_pool_added_at,
    candidate_name: m.candidate_name,
    email: m.email,
    mobile: m.mobile,
    current_location: m.current_location,
    preferred_role: m.talent_pool_role || m.job_applied,
    experience: m.experience,
    source: m.source,
    pool_status: m.talent_pool_status || "Available",
    next_contact_date: m.talent_pool_next_contact,
    owner: m.talent_pool_owner,
    remarks: m.talent_pool_notes,
  }))
  if (!term) return mapped
  return mapped.filter((r) =>
    [r.candidate_id, r.candidate_name, r.email, r.mobile, r.preferred_role]
      .some((v) => String(v || "").toLowerCase().includes(term)),
  )
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
