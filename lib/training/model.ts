/**
 * Spec38 (#230-233) — Training & policy acknowledgment: pure domain logic.
 *
 * This module has NO database or network dependencies so the business rules
 * (quiz scoring, status/overdue derivation, media access control, certificate
 * numbering, evidence normalization, role matching, input validation) can be
 * unit-tested in isolation and reused on both request paths.
 */

export const LESSON_TYPES = ["video", "document", "text"] as const
export type LessonType = (typeof LESSON_TYPES)[number]

export const ASSIGNMENT_STATUSES = ["assigned", "started", "completed", "overdue"] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]

export const MEDIA_ACCESS = ["assigned", "tenant"] as const
export type MediaAccess = (typeof MEDIA_ACCESS)[number]

export function isLessonType(v: unknown): v is LessonType {
  return typeof v === "string" && (LESSON_TYPES as readonly string[]).includes(v)
}

export function isMediaAccess(v: unknown): v is MediaAccess {
  return typeof v === "string" && (MEDIA_ACCESS as readonly string[]).includes(v)
}

/** Parse a JSON column (string or already-parsed) into a string array. */
export function parseStringArray(raw: unknown): string[] {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
}

/** Parse quiz options (JSON string or array) into a clean string array. */
export function parseOptions(raw: unknown): string[] {
  return parseStringArray(raw)
}

export type QuizQuestion = {
  id: number
  correct_index: number
  points: number
}

export type QuizScore = {
  totalQuestions: number
  answeredCount: number
  correctCount: number
  earnedPoints: number
  totalPoints: number
  /** Percentage 0-100, rounded to the nearest integer, weighted by points. */
  score: number
  passed: boolean
}

/**
 * Score a quiz submission. `answers` maps question id -> selected option index.
 * The percentage is weighted by each question's points so a 3-point question
 * counts more than a 1-point one. Passing requires `score >= passScore`.
 */
export function scoreQuiz(
  questions: QuizQuestion[],
  answers: Record<string | number, number>,
  passScore: number,
): QuizScore {
  let earnedPoints = 0
  let totalPoints = 0
  let correctCount = 0
  let answeredCount = 0
  for (const q of questions) {
    const points = Number.isFinite(q.points) && q.points > 0 ? q.points : 1
    totalPoints += points
    const picked = answers[q.id]
    if (picked !== undefined && picked !== null) answeredCount += 1
    if (picked !== undefined && Number(picked) === Number(q.correct_index)) {
      earnedPoints += points
      correctCount += 1
    }
  }
  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0
  const pass = clampScore(passScore)
  return {
    totalQuestions: questions.length,
    answeredCount,
    correctCount,
    earnedPoints,
    totalPoints,
    score,
    passed: totalPoints > 0 && score >= pass,
  }
}

export function clampScore(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

export type AssignmentLike = {
  status: AssignmentStatus | string
  due_date?: string | Date | null
  completed_at?: string | Date | null
}

/**
 * Derive the *effective* status of an assignment at read time. Completed always
 * wins. An incomplete assignment past its due date is reported as overdue
 * regardless of the stored status, so a nightly job is not required for the UI
 * to be correct.
 */
export function deriveStatus(a: AssignmentLike, now: Date = new Date()): AssignmentStatus {
  if (a.completed_at || a.status === "completed") return "completed"
  if (isOverdue(a.due_date ?? null, now)) return "overdue"
  if (a.status === "started") return "started"
  return "assigned"
}

export function isOverdue(dueDate: string | Date | null, now: Date = new Date()): boolean {
  if (!dueDate) return false
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate)
  if (Number.isNaN(due.getTime())) return false
  // Due dates are day-granular; overdue only once the whole due day has passed.
  const endOfDue = new Date(due)
  endOfDue.setHours(23, 59, 59, 999)
  return now.getTime() > endOfDue.getTime()
}

/** Completion requires a passing quiz result AND every lesson completed. */
export function meetsCompletionRule(input: {
  totalLessons: number
  completedLessons: number
  hasQuiz: boolean
  quizPassed: boolean
}): boolean {
  const lessonsDone = input.completedLessons >= input.totalLessons
  if (!lessonsDone) return false
  if (input.hasQuiz) return input.quizPassed
  return true
}

/** Deterministic, human-readable certificate number, unique per assignment. */
export function certificateNumber(assignmentId: number, issuedAt: Date = new Date()): string {
  const year = issuedAt.getFullYear()
  return `CERT-${year}-${String(assignmentId).padStart(6, "0")}`
}

export type Evidence = {
  ip: string | null
  userAgent: string | null
  capturedAt: string
}

/** Normalize acknowledgment evidence captured from the request. */
export function normalizeEvidence(raw: {
  ip?: string | null
  userAgent?: string | null
  capturedAt?: string | Date | null
}): Evidence {
  const capturedAt =
    raw.capturedAt instanceof Date
      ? raw.capturedAt.toISOString()
      : typeof raw.capturedAt === "string" && raw.capturedAt
        ? raw.capturedAt
        : new Date().toISOString()
  return {
    ip: cleanShort(raw.ip, 64),
    userAgent: cleanShort(raw.userAgent, 400),
    capturedAt,
  }
}

function cleanShort(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  return s.slice(0, max)
}

export function isMediaExpired(expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false
  const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (Number.isNaN(exp.getTime())) return false
  return now.getTime() > exp.getTime()
}

/**
 * Access-control decision for a private media object. Tenant isolation is
 * enforced separately at the data layer; this decides intra-tenant visibility:
 *   • expired media is denied for everyone;
 *   • managers (course authors/HR) may always view;
 *   • `tenant` media is visible to any authenticated member of the tenant;
 *   • `assigned` media is visible only to employees assigned to a course that
 *     uses it.
 */
export function canAccessMedia(input: {
  access: MediaAccess | string
  expiresAt: string | Date | null | undefined
  isManager: boolean
  mediaCourseIds: number[]
  employeeCourseIds: number[]
  now?: Date
}): { allowed: boolean; reason?: "expired" | "not_assigned" } {
  const now = input.now ?? new Date()
  if (isMediaExpired(input.expiresAt, now)) return { allowed: false, reason: "expired" }
  if (input.isManager) return { allowed: true }
  if (input.access === "tenant") return { allowed: true }
  const assigned = input.mediaCourseIds.some((c) => input.employeeCourseIds.includes(c))
  return assigned ? { allowed: true } : { allowed: false, reason: "not_assigned" }
}

/**
 * Does a course's role targeting match an employee? `roles` is the course's
 * configured list of designations/roles; matching is case-insensitive. The
 * sentinel "all" (or an empty list) targets every active employee.
 */
export function roleMatches(roles: string[], employee: { designation?: string | null; role?: string | null }): boolean {
  if (roles.length === 0) return true
  const wanted = roles.map((r) => r.toLowerCase())
  if (wanted.includes("all") || wanted.includes("*")) return true
  const desig = (employee.designation ?? "").toLowerCase().trim()
  const role = (employee.role ?? "").toLowerCase().trim()
  return (!!desig && wanted.includes(desig)) || (!!role && wanted.includes(role))
}

export type CourseInput = {
  title?: unknown
  code?: unknown
  description?: unknown
  category?: unknown
  roles?: unknown
  pass_score?: unknown
  due_days?: unknown
  active?: unknown
}

export type ValidatedCourse = {
  title: string
  code: string | null
  description: string | null
  category: string | null
  roles: string[]
  pass_score: number
  due_days: number | null
  active: boolean
}

export function validateCourse(input: CourseInput): { ok: true; value: ValidatedCourse } | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!title) return { ok: false, error: "Title is required" }
  if (title.length > 200) return { ok: false, error: "Title is too long" }
  const dueDaysRaw = input.due_days
  let due_days: number | null = null
  if (dueDaysRaw !== undefined && dueDaysRaw !== null && String(dueDaysRaw) !== "") {
    const n = Number(dueDaysRaw)
    if (!Number.isInteger(n) || n < 0 || n > 3650) return { ok: false, error: "Due days must be between 0 and 3650" }
    due_days = n
  }
  return {
    ok: true,
    value: {
      title,
      code: cleanShort(input.code, 40),
      description: typeof input.description === "string" ? input.description.trim() || null : null,
      category: cleanShort(input.category, 120),
      roles: parseStringArray(input.roles),
      pass_score: input.pass_score === undefined ? 70 : clampScore(input.pass_score),
      due_days,
      active: input.active === undefined ? true : Boolean(input.active),
    },
  }
}

export type PolicyInput = {
  title?: unknown
  code?: unknown
  category?: unknown
  body?: unknown
  summary?: unknown
  effective_date?: unknown
}

export type ValidatedPolicy = {
  title: string
  code: string | null
  category: string | null
  body: string
  summary: string | null
  effective_date: string | null
}

export function validatePolicy(input: PolicyInput): { ok: true; value: ValidatedPolicy } | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!title) return { ok: false, error: "Title is required" }
  if (title.length > 200) return { ok: false, error: "Title is too long" }
  const body = typeof input.body === "string" ? input.body.trim() : ""
  if (!body) return { ok: false, error: "Policy body is required" }
  let effective_date: string | null = null
  if (input.effective_date !== undefined && input.effective_date !== null && String(input.effective_date) !== "") {
    const d = new Date(String(input.effective_date))
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid effective date" }
    effective_date = d.toISOString().slice(0, 10)
  }
  return {
    ok: true,
    value: {
      title,
      code: cleanShort(input.code, 40),
      category: cleanShort(input.category, 120),
      body,
      summary: cleanShort(input.summary, 600),
      effective_date,
    },
  }
}
