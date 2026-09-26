/**
 * Pure domain model for Training & Policy Acknowledgment (Spec38, #230-233).
 * ---------------------------------------------------------------------------
 * Deliberately free of `server-only`, DB and `Date.now()` so every rule can be
 * unit tested in isolation (see test/training-model.test.ts) and reused by the
 * server store (lib/training/store.ts) and the API routes.
 *
 * This module owns NO persistence. It only:
 *   • validates + normalizes course / module / lesson / quiz / policy input,
 *   • scores quizzes,
 *   • computes assignment status (assigned / started / completed / overdue),
 *   • decides course completion (all lessons done + quiz passed when present),
 *   • normalizes acknowledgment evidence and decides re-acknowledgment after a
 *     policy version change.
 */

// ── Enumerations ─────────────────────────────────────────────────────────────

export const COURSE_STATUSES = ["draft", "published", "archived"] as const
export type CourseStatus = (typeof COURSE_STATUSES)[number]

export const LESSON_TYPES = ["video", "document"] as const
export type LessonType = (typeof LESSON_TYPES)[number]

/** Persisted assignment lifecycle. `assigned` is the initial state. */
export const ASSIGNMENT_STATUSES = ["assigned", "started", "completed", "overdue"] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]

/** How a course/policy is targeted to employees. */
export const AUDIENCE_TYPES = ["all", "role", "department", "designation", "employees"] as const
export type AudienceType = (typeof AUDIENCE_TYPES)[number]

export const POLICY_STATUSES = ["draft", "published", "archived"] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]

export const DEFAULT_PASS_MARK = 70
export const DEFAULT_DUE_DAYS = 30
const MAX_DUE_DAYS = 3650
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_TEXT = 20_000

export class TrainingError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "TrainingError"
    this.status = status
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export const normStr = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

export const dateOf = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null)

export function isValidDate(v: unknown): boolean {
  if (!v) return false
  const s = String(v).slice(0, 10)
  if (!ISO_DATE_RE.test(s)) return false
  return Number.isFinite(Date.parse(s))
}

function normText(v: unknown, label: string, { required = false, max = MAX_TEXT } = {}): string | null {
  const s = normStr(v)
  if (!s) {
    if (required) throw new TrainingError(`${label} is required.`)
    return null
  }
  if (s.length > max) throw new TrainingError(`${label} must be at most ${max} characters.`)
  return s
}

function normInt(v: unknown, label: string, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}): number {
  if (v === undefined || v === null || v === "") return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max)
    throw new TrainingError(`${label} must be an integer between ${min} and ${max}.`)
  return n
}

/** Whole days between two YYYY-MM-DD dates (b - a); positive when b is later. */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso.slice(0, 10)}T00:00:00Z`)
  const b = Date.parse(`${bIso.slice(0, 10)}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/** Add whole days to a YYYY-MM-DD date, returning a YYYY-MM-DD date. */
export function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(t)) throw new TrainingError("Invalid date.")
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

// ── Audience ─────────────────────────────────────────────────────────────────

export type AudienceConfig = {
  roles?: string[]
  departments?: string[]
  designations?: string[]
  employeeIds?: number[]
}

export function parseAudienceConfig(raw: unknown): AudienceConfig {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as AudienceConfig
    } catch {
      return {}
    }
  }
  return raw as AudienceConfig
}

/** Validate a targeted audience has at least one selection. Throws on empty. */
export function validateAudience(type: AudienceType, cfg: AudienceConfig): AudienceConfig {
  if (!AUDIENCE_TYPES.includes(type)) throw new TrainingError(`Invalid audience type "${type}".`)
  const clean: AudienceConfig = {}
  switch (type) {
    case "all":
      return {}
    case "role": {
      const roles = (cfg.roles ?? []).map((r) => String(r).trim()).filter(Boolean)
      if (!roles.length) throw new TrainingError("Select at least one role for a role-based audience.")
      clean.roles = [...new Set(roles)]
      return clean
    }
    case "department": {
      const d = (cfg.departments ?? []).map((r) => String(r).trim()).filter(Boolean)
      if (!d.length) throw new TrainingError("Select at least one department.")
      clean.departments = [...new Set(d)]
      return clean
    }
    case "designation": {
      const d = (cfg.designations ?? []).map((r) => String(r).trim()).filter(Boolean)
      if (!d.length) throw new TrainingError("Select at least one designation.")
      clean.designations = [...new Set(d)]
      return clean
    }
    case "employees": {
      const ids = (cfg.employeeIds ?? []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
      if (!ids.length) throw new TrainingError("Select at least one employee.")
      clean.employeeIds = [...new Set(ids)]
      return clean
    }
  }
}

// ── Course / module / lesson / quiz validation ───────────────────────────────

export type CourseInput = {
  title?: string
  description?: string | null
  category?: string | null
  status?: string
  mandatory?: boolean | number | string
  pass_mark?: number | string | null
  due_days?: number | string | null
  audience_type?: string
  audience_config?: AudienceConfig | string | null
}

export type NormalizedCourse = {
  title: string
  description: string | null
  category: string | null
  status: CourseStatus
  mandatory: 0 | 1
  pass_mark: number
  due_days: number
  audience_type: AudienceType
  audience_config: AudienceConfig
}

export function validateCourseInput(input: CourseInput, isUpdate = false): NormalizedCourse {
  const title = normText(input.title, "Course title", { required: !isUpdate, max: 200 }) ?? ""
  if (!isUpdate && !title) throw new TrainingError("Course title is required.")

  const status = (normStr(input.status) ?? "draft") as CourseStatus
  if (!COURSE_STATUSES.includes(status)) throw new TrainingError(`Invalid course status "${status}".`)

  const passMark = normInt(input.pass_mark, "Pass mark", { min: 0, max: 100, fallback: DEFAULT_PASS_MARK })
  const dueDays = normInt(input.due_days, "Due days", { min: 0, max: MAX_DUE_DAYS, fallback: DEFAULT_DUE_DAYS })

  const audienceType = (normStr(input.audience_type) ?? "all") as AudienceType
  const audienceConfig = validateAudience(audienceType, parseAudienceConfig(input.audience_config))

  return {
    title,
    description: normText(input.description, "Description"),
    category: normText(input.category, "Category", { max: 120 }),
    status,
    mandatory: toBool(input.mandatory) ? 1 : 0,
    pass_mark: passMark,
    due_days: dueDays,
    audience_type: audienceType,
    audience_config: audienceConfig,
  }
}

export function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  const s = String(v ?? "").trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

export type ModuleInput = { title?: string; summary?: string | null; sort_order?: number | string | null }
export type NormalizedModule = { title: string; summary: string | null; sort_order: number }

export function validateModuleInput(input: ModuleInput, isUpdate = false): NormalizedModule {
  const title = normText(input.title, "Module title", { required: !isUpdate, max: 200 }) ?? ""
  if (!isUpdate && !title) throw new TrainingError("Module title is required.")
  return {
    title,
    summary: normText(input.summary, "Module summary", { max: 2000 }),
    sort_order: normInt(input.sort_order, "Sort order", { min: 0, max: 100000, fallback: 0 }),
  }
}

export type LessonInput = {
  title?: string
  lesson_type?: string
  media_file_id?: number | string | null
  external_url?: string | null
  content?: string | null
  duration_seconds?: number | string | null
  sort_order?: number | string | null
}

export type NormalizedLesson = {
  title: string
  lesson_type: LessonType
  media_file_id: number | null
  external_url: string | null
  content: string | null
  duration_seconds: number
  sort_order: number
}

export function validateLessonInput(input: LessonInput, isUpdate = false): NormalizedLesson {
  const title = normText(input.title, "Lesson title", { required: !isUpdate, max: 200 }) ?? ""
  if (!isUpdate && !title) throw new TrainingError("Lesson title is required.")

  const lessonType = (normStr(input.lesson_type) ?? "document") as LessonType
  if (!LESSON_TYPES.includes(lessonType)) throw new TrainingError(`Invalid lesson type "${lessonType}".`)

  const mediaFileId = input.media_file_id == null || input.media_file_id === "" ? null : normInt(input.media_file_id, "Media file", { min: 1 })
  const externalUrl = normText(input.external_url, "External URL", { max: 2000 })
  if (externalUrl && !/^https?:\/\//i.test(externalUrl)) throw new TrainingError("External URL must start with http:// or https://.")

  // A lesson must carry SOME content: an uploaded media file, an external URL, or inline text.
  const content = normText(input.content, "Lesson content")
  if (!isUpdate && !mediaFileId && !externalUrl && !content)
    throw new TrainingError("A lesson needs an uploaded file, an external link, or written content.")

  return {
    title,
    lesson_type: lessonType,
    media_file_id: mediaFileId,
    external_url: externalUrl,
    content,
    duration_seconds: normInt(input.duration_seconds, "Duration", { min: 0, max: 24 * 3600, fallback: 0 }),
    sort_order: normInt(input.sort_order, "Sort order", { min: 0, max: 100000, fallback: 0 }),
  }
}

export type QuizQuestionInput = {
  module_id?: number | string | null
  question?: string
  options?: unknown
  correct_index?: number | string | null
  sort_order?: number | string | null
}

export type NormalizedQuizQuestion = {
  module_id: number | null
  question: string
  options: string[]
  correct_index: number
  sort_order: number
}

export function validateQuizQuestionInput(input: QuizQuestionInput): NormalizedQuizQuestion {
  const question = normText(input.question, "Question", { required: true, max: 2000 })!
  let options: string[]
  const raw = input.options
  const arr = typeof raw === "string" ? safeJsonArray(raw) : raw
  if (!Array.isArray(arr)) throw new TrainingError("Question options must be a list.")
  options = arr.map((o) => String(o ?? "").trim()).filter((o) => o.length > 0)
  if (options.length < 2) throw new TrainingError("A question needs at least two answer options.")
  if (options.length > 10) throw new TrainingError("A question can have at most ten answer options.")

  const correctIndex = normInt(input.correct_index, "Correct answer", { min: 0, max: options.length - 1, fallback: 0 })
  if (correctIndex > options.length - 1) throw new TrainingError("The correct answer index is out of range.")

  return {
    module_id: input.module_id == null || input.module_id === "" ? null : normInt(input.module_id, "Module", { min: 1 }),
    question,
    options,
    correct_index: correctIndex,
    sort_order: normInt(input.sort_order, "Sort order", { min: 0, max: 100000, fallback: 0 }),
  }
}

function safeJsonArray(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── Quiz scoring ─────────────────────────────────────────────────────────────

export type ScorableQuestion = { id?: number | string; correct_index: number }

export type QuizResult = {
  total: number
  correct: number
  score: number // 0-100, integer
  passed: boolean
}

/**
 * Score a set of answers against the quiz's correct indices. `answers` maps a
 * question id -> the chosen option index. Missing / wrong answers score zero.
 * With no questions the quiz is vacuously passed with a 100 score, so a course
 * that has lessons but no quiz can still complete.
 */
export function scoreQuiz(
  questions: ScorableQuestion[],
  answers: Record<string | number, number>,
  passMark = DEFAULT_PASS_MARK,
): QuizResult {
  const total = questions.length
  if (total === 0) return { total: 0, correct: 0, score: 100, passed: true }
  let correct = 0
  for (const q of questions) {
    const key = q.id ?? ""
    const chosen = answers[key as any] ?? answers[String(key) as any]
    if (Number(chosen) === Number(q.correct_index)) correct++
  }
  const score = Math.round((correct / total) * 100)
  return { total, correct, score, passed: score >= passMark }
}

// ── Assignment status + completion rules ─────────────────────────────────────

export type AssignmentState = {
  status: AssignmentStatus
  started_at?: string | null
  completed_at?: string | null
  due_date?: string | null
}

/**
 * Derive the *effective* status of an assignment at `now`. A stored status of
 * `completed` is terminal. Otherwise a past due date makes it `overdue`, a
 * present `started_at` makes it `started`, else `assigned`.
 */
export function computeAssignmentStatus(a: AssignmentState, now: Date = new Date()): AssignmentStatus {
  if (a.completed_at || a.status === "completed") return "completed"
  const today = now.toISOString().slice(0, 10)
  if (a.due_date && dateOf(a.due_date)! < today) return "overdue"
  if (a.started_at) return "started"
  return "assigned"
}

export type CompletionInput = {
  lessonsTotal: number
  lessonsCompleted: number
  hasQuiz: boolean
  quizPassed: boolean
}

/**
 * A course is complete when EVERY lesson is done AND, when the course has a
 * quiz, the learner has passed it. A course with lessons but no quiz completes
 * on finishing all lessons; a course with no lessons and no quiz cannot be
 * "completed" (nothing to do) — guard against that with lessonsTotal > 0.
 */
export function isCourseComplete(c: CompletionInput): boolean {
  if (c.lessonsTotal <= 0 && !c.hasQuiz) return false
  const lessonsDone = c.lessonsCompleted >= c.lessonsTotal
  if (!lessonsDone) return false
  if (c.hasQuiz && !c.quizPassed) return false
  return true
}

// ── Policy validation ────────────────────────────────────────────────────────

export type PolicyInput = {
  title?: string
  category?: string | null
  description?: string | null
  audience_type?: string
  audience_config?: AudienceConfig | string | null
  requires_acknowledgment?: boolean | number | string
}

export type NormalizedPolicy = {
  title: string
  category: string | null
  description: string | null
  audience_type: AudienceType
  audience_config: AudienceConfig
  requires_acknowledgment: 0 | 1
}

export function validatePolicyInput(input: PolicyInput, isUpdate = false): NormalizedPolicy {
  const title = normText(input.title, "Policy title", { required: !isUpdate, max: 200 }) ?? ""
  if (!isUpdate && !title) throw new TrainingError("Policy title is required.")
  const audienceType = (normStr(input.audience_type) ?? "all") as AudienceType
  const audienceConfig = validateAudience(audienceType, parseAudienceConfig(input.audience_config))
  return {
    title,
    category: normText(input.category, "Category", { max: 120 }),
    description: normText(input.description, "Description"),
    audience_type: audienceType,
    audience_config: audienceConfig,
    requires_acknowledgment: input.requires_acknowledgment === undefined ? 1 : toBool(input.requires_acknowledgment) ? 1 : 0,
  }
}

export type PolicyVersionInput = {
  version_label?: string | null
  content?: string | null
  media_file_id?: number | string | null
  effective_date?: string | null
  change_summary?: string | null
}

export type NormalizedPolicyVersion = {
  version_label: string | null
  content: string | null
  media_file_id: number | null
  effective_date: string | null
  change_summary: string | null
}

export function validatePolicyVersionInput(input: PolicyVersionInput): NormalizedPolicyVersion {
  const content = normText(input.content, "Policy content")
  const mediaFileId = input.media_file_id == null || input.media_file_id === "" ? null : normInt(input.media_file_id, "Media file", { min: 1 })
  if (!content && !mediaFileId) throw new TrainingError("A policy version needs written content or an attached document.")
  const effectiveDate = dateOf(input.effective_date)
  if (effectiveDate && !isValidDate(effectiveDate)) throw new TrainingError("Effective date is invalid.")
  return {
    version_label: normText(input.version_label, "Version label", { max: 40 }),
    content,
    media_file_id: mediaFileId,
    effective_date: effectiveDate,
    change_summary: normText(input.change_summary, "Change summary", { max: 1000 }),
  }
}

// ── Acknowledgment evidence + re-ack decision ────────────────────────────────

export type AckEvidenceInput = {
  ip?: string | null
  user_agent?: string | null
  statement?: string | null
  signature_name?: string | null
}

export type NormalizedAckEvidence = {
  ip: string | null
  user_agent: string | null
  statement: string
  signature_name: string | null
}

export const DEFAULT_ACK_STATEMENT = "I have read, understood and agree to comply with this policy."

export function normalizeAckEvidence(input: AckEvidenceInput): NormalizedAckEvidence {
  const signature = normText(input.signature_name, "Signature", { max: 190 })
  if (!signature) throw new TrainingError("Please type your full name to sign this acknowledgment.")
  return {
    ip: normStr(input.ip)?.slice(0, 45) ?? null,
    user_agent: normStr(input.user_agent)?.slice(0, 500) ?? null,
    statement: normText(input.statement, "Statement", { max: 2000 }) ?? DEFAULT_ACK_STATEMENT,
    signature_name: signature,
  }
}

/**
 * Decide whether an employee still needs to acknowledge a policy. They must
 * acknowledge when there is no ack row for the CURRENT published version — i.e.
 * a brand new assignment, or a policy that has since been re-published with a
 * new version (the prior ack was for an older version and no longer counts).
 */
export function needsAcknowledgment(currentVersionId: number | null, acknowledgedVersionIds: number[]): boolean {
  if (!currentVersionId) return false // nothing published yet
  return !acknowledgedVersionIds.includes(currentVersionId)
}
