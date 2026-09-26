import "server-only"
import { randomUUID, createHash } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { getTenantId } from "@/lib/api-auth"
import type { SessionPayload } from "@/lib/auth"
import { resolveEmployee, type EmployeeIdentity } from "@/lib/knowledge-base"
import { recordAuditLog } from "@/lib/audit-log-store"
import { getSignedDownloadUrl, keyBelongsToTenant, uploadFile } from "@/lib/storage"
import {
  lessonCompletable,
  policyAckState,
  ackVersionConflict,
  isMediaExpired,
  scoreQuiz,
  deriveStatus,
  meetsCompletionRule,
  certificateNumber,
  normalizeEvidence,
  canAccessMedia,
  roleMatches,
  parseStringArray,
  parseOptions,
  type ValidatedCourse,
  type ValidatedPolicy,
  type LessonType,
  type MediaAccess,
  type Evidence,
} from "./model"

/**
 * Spec38 (#230-233) — Training & policy acknowledgment: tenant-scoped data
 * access. Every statement carries a tenant_id predicate (fail-closed guard,
 * lib/tenant-guard.ts). Media is referenced by central private-storage key and
 * served via short-lived signed URLs; access control + expiry are enforced here
 * before a URL is ever minted.
 */

// ---------------------------------------------------------------------------
// Schema (mirrors database/migrations/2027-02-03-spec38-*.sql; self-heals)
// ---------------------------------------------------------------------------
let schemaReady: Promise<void> | null = null

export function ensureTrainingSchema(): Promise<void> {
  if (!schemaReady) schemaReady = createSchema()
  return schemaReady
}

async function createSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS training_courses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    code VARCHAR(40) DEFAULT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT DEFAULT NULL,
    category VARCHAR(120) DEFAULT NULL,
    roles JSON DEFAULT NULL,
    pass_score INT NOT NULL DEFAULT 70,
    due_days INT DEFAULT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT DEFAULT NULL,
    created_by_name VARCHAR(150) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_training_course_code (tenant_id, code),
    KEY idx_training_course_tenant (tenant_id, active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_modules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    course_id INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_training_module_course (tenant_id, course_id, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_lessons (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    course_id INT NOT NULL,
    module_id INT DEFAULT NULL,
    title VARCHAR(200) NOT NULL,
    lesson_type ENUM('video','document','text') NOT NULL DEFAULT 'text',
    media_id INT DEFAULT NULL,
    content MEDIUMTEXT DEFAULT NULL,
    duration_seconds INT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_training_lesson_course (tenant_id, course_id, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_quiz_questions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    course_id INT NOT NULL,
    question TEXT NOT NULL,
    options JSON NOT NULL,
    correct_index INT NOT NULL DEFAULT 0,
    points INT NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_training_quiz_course (tenant_id, course_id, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_media (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    storage_key VARCHAR(1024) NOT NULL,
    file_name VARCHAR(255) DEFAULT NULL,
    mime VARCHAR(150) DEFAULT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    access ENUM('assigned','tenant') NOT NULL DEFAULT 'assigned',
    expires_at DATETIME DEFAULT NULL,
    created_by INT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_training_media_tenant (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    course_id INT NOT NULL,
    employee_id INT NOT NULL,
    employee_name VARCHAR(190) DEFAULT NULL,
    assigned_role VARCHAR(120) DEFAULT NULL,
    status ENUM('assigned','started','completed','overdue') NOT NULL DEFAULT 'assigned',
    due_date DATE DEFAULT NULL,
    started_at DATETIME DEFAULT NULL,
    completed_at DATETIME DEFAULT NULL,
    score INT DEFAULT NULL,
    passed TINYINT(1) DEFAULT NULL,
    attempts INT NOT NULL DEFAULT 0,
    reassigned_count INT NOT NULL DEFAULT 0,
    assigned_by INT DEFAULT NULL,
    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key VARCHAR(80) DEFAULT NULL,
    UNIQUE KEY uq_training_assignment (tenant_id, course_id, employee_id),
    KEY idx_training_assignment_emp (tenant_id, employee_id, status),
    KEY idx_training_assignment_course (tenant_id, course_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_lesson_progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    assignment_id INT NOT NULL,
    lesson_id INT NOT NULL,
    completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_training_progress (tenant_id, assignment_id, lesson_id),
    KEY idx_training_progress_assignment (tenant_id, assignment_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_quiz_attempts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    assignment_id INT NOT NULL,
    course_id INT NOT NULL,
    employee_id INT NOT NULL,
    score INT NOT NULL DEFAULT 0,
    passed TINYINT(1) NOT NULL DEFAULT 0,
    answers JSON DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_training_attempt_assignment (tenant_id, assignment_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_certificates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    assignment_id INT NOT NULL,
    course_id INT NOT NULL,
    employee_id INT NOT NULL,
    employee_name VARCHAR(190) DEFAULT NULL,
    course_title VARCHAR(200) DEFAULT NULL,
    certificate_no VARCHAR(60) NOT NULL,
    score INT DEFAULT NULL,
    issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_training_cert (tenant_id, assignment_id),
    UNIQUE KEY uq_training_cert_no (tenant_id, certificate_no),
    KEY idx_training_cert_emp (tenant_id, employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_policies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    code VARCHAR(40) DEFAULT NULL,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(120) DEFAULT NULL,
    current_version INT NOT NULL DEFAULT 1,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT DEFAULT NULL,
    created_by_name VARCHAR(150) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_training_policy_code (tenant_id, code),
    KEY idx_training_policy_tenant (tenant_id, active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_policy_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    policy_id INT NOT NULL,
    version INT NOT NULL,
    body MEDIUMTEXT DEFAULT NULL,
    summary VARCHAR(600) DEFAULT NULL,
    effective_date DATE DEFAULT NULL,
    published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by INT DEFAULT NULL,
    published_by_name VARCHAR(150) DEFAULT NULL,
    idempotency_key VARCHAR(80) DEFAULT NULL,
    UNIQUE KEY uq_training_policy_version (tenant_id, policy_id, version),
    UNIQUE KEY uq_training_policy_version_idem (tenant_id, policy_id, idempotency_key),
    KEY idx_training_policy_version (tenant_id, policy_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS training_policy_acknowledgments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    policy_id INT NOT NULL,
    version INT NOT NULL,
    employee_id INT NOT NULL,
    employee_name VARCHAR(190) DEFAULT NULL,
    acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    evidence JSON DEFAULT NULL,
    idempotency_key VARCHAR(80) DEFAULT NULL,
    UNIQUE KEY uq_training_ack (tenant_id, policy_id, version, employee_id),
    KEY idx_training_ack_emp (tenant_id, employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Follow-up migration (2027-02-04): tables created by the first Spec38 cut
  // lack the policy-publish idempotency key. Additive; ignore if present.
  for (const sql of [
    "ALTER TABLE training_policy_versions ADD COLUMN idempotency_key VARCHAR(80) DEFAULT NULL",
    "ALTER TABLE training_policy_versions ADD UNIQUE KEY uq_training_policy_version_idem (tenant_id, policy_id, idempotency_key)",
  ]) {
    try {
      await query(sql)
    } catch {
      // already applied
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export class TrainingError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "TrainingError"
    this.status = status
  }
}

async function tid(): Promise<number> {
  const t = await getTenantId()
  if (t == null) throw new TrainingError("No tenant in context", 403)
  return t
}

async function audit(
  action: string,
  entityType: string,
  entityId: string | number | null,
  extra?: { entityLabel?: string | null; metadata?: Record<string, unknown> | null; result?: "success" | "failure" | "denied" },
) {
  await recordAuditLog({
    action,
    entityType,
    entityId,
    entityLabel: extra?.entityLabel ?? null,
    metadata: extra?.metadata ?? null,
    result: extra?.result ?? "success",
  })
}

export type TenantEmployee = {
  id: number
  employee_name: string | null
  designation: string | null
  department: string | null
  user_id: number
}

/**
 * Active employees that belong to the acting tenant. `hr_employees` is
 * tenant-global in this ERP, so membership is established through the linked
 * login in `users` (tenant-scoped): either the explicit `user_id` link or, for
 * unlinked records, a matching email. Employees without a tenant login cannot
 * sign in to take training and are never targeted — this is what keeps one
 * tenant's assignments/notifications from reaching another tenant's staff.
 */
export async function listTenantEmployees(t: number): Promise<TenantEmployee[]> {
  const { ensureEmployeeUserLinkSchema } = await import("@/lib/employee-user-link")
  await ensureEmployeeUserLinkSchema()
  const rows = await query<any[]>(
    `SELECT e.id, e.employee_name, e.designation, e.department, u.id AS user_id
       FROM hr_employees e
       JOIN users u
         ON u.tenant_id = ?
        AND (u.id = e.user_id OR (e.user_id IS NULL AND u.email IN (e.official_email, e.personal_email)))
      WHERE (e.employment_status IS NULL OR LOWER(e.employment_status) = 'active')
      ORDER BY e.employee_name`,
    [t],
  )
  const seen = new Map<number, TenantEmployee>()
  for (const r of rows) {
    const id = Number(r.id)
    if (!seen.has(id)) {
      seen.set(id, {
        id,
        employee_name: r.employee_name ?? null,
        designation: r.designation ?? null,
        department: r.department ?? null,
        user_id: Number(r.user_id),
      })
    }
  }
  return [...seen.values()]
}

/** Best-effort in-app notifications through the central notification engine. */
async function notifyUsers(
  t: number,
  items: { userId: number; key: string; title: string; body: string; link: string }[],
) {
  if (!items.length) return
  try {
    const { ensureNotificationEngineSchema } = await import("@/lib/notification-engine/schema")
    const { enqueueNotification } = await import("@/lib/notification-engine/service")
    await ensureNotificationEngineSchema()
    for (const n of items) {
      try {
        await withTransaction((c) =>
          enqueueNotification(c, {
            tenantId: t,
            userId: n.userId,
            channel: "in_app",
            key: n.key.slice(0, 191),
            title: n.title.slice(0, 255),
            body: n.body.slice(0, 4000),
            link: n.link,
            context: { moduleKey: "hr", entityTable: "training", kind: "training" },
          }),
        )
      } catch (err) {
        console.error("[training] notification skipped:", (err as Error).message)
      }
    }
  } catch (err) {
    console.error("[training] notification engine unavailable:", (err as Error).message)
  }
}

/** Best-effort follow-up task in the shared Tasks module for an assignment. */
async function createAssignmentTask(input: {
  userId: number
  courseTitle: string
  dueDate: string | null
  assignmentId: number
}) {
  try {
    const { createTask } = await import("@/lib/tasks/model")
    await createTask({
      title: `Complete training: ${input.courseTitle}`.slice(0, 200),
      description: "Assigned via Training & Policies. Open My learning to start the course.",
      task_type: "Task",
      priority: "Medium",
      assignee_id: input.userId,
      due_date: input.dueDate,
      source_module: "training",
      source_entity: "training_assignment",
      source_entity_id: String(input.assignmentId),
    })
  } catch (err) {
    console.error("[training] task creation skipped:", (err as Error).message)
  }
}

/** Resolve the acting employee or fail — required for every learner action. */
export async function requireEmployee(session: SessionPayload): Promise<EmployeeIdentity> {
  const emp = await resolveEmployee(session)
  if (!emp) throw new TrainingError("No employee record is linked to your account", 403)
  return emp
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------
export async function listCourses() {
  await ensureTrainingSchema()
  const t = await tid()
  const rows = await query<any[]>(
    `SELECT c.*,
        (SELECT COUNT(*) FROM training_lessons tl WHERE tl.tenant_id = c.tenant_id AND tl.course_id = c.id) AS lesson_count,
        (SELECT COUNT(*) FROM training_quiz_questions tq WHERE tq.tenant_id = c.tenant_id AND tq.course_id = c.id) AS question_count,
        (SELECT COUNT(*) FROM training_assignments ta WHERE ta.tenant_id = c.tenant_id AND ta.course_id = c.id) AS assigned_count,
        (SELECT COUNT(*) FROM training_assignments ta WHERE ta.tenant_id = c.tenant_id AND ta.course_id = c.id AND ta.status = 'completed') AS completed_count
       FROM training_courses c
      WHERE c.tenant_id = ?
      ORDER BY c.created_at DESC`,
    [t],
  )
  return rows.map((r) => ({ ...r, roles: parseStringArray(r.roles), active: !!r.active }))
}

export async function getCourseDetail(courseId: number, opts: { includeAnswers?: boolean } = {}) {
  await ensureTrainingSchema()
  const t = await tid()
  const course = (await query<any[]>(`SELECT * FROM training_courses WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, courseId]))[0]
  if (!course) throw new TrainingError("Course not found", 404)
  const modules = await query<any[]>(
    `SELECT * FROM training_modules WHERE tenant_id = ? AND course_id = ? ORDER BY sort_order, id`,
    [t, courseId],
  )
  const lessons = await query<any[]>(
    `SELECT * FROM training_lessons WHERE tenant_id = ? AND course_id = ? ORDER BY sort_order, id`,
    [t, courseId],
  )
  const questions = await query<any[]>(
    `SELECT * FROM training_quiz_questions WHERE tenant_id = ? AND course_id = ? ORDER BY sort_order, id`,
    [t, courseId],
  )
  return {
    ...course,
    roles: parseStringArray(course.roles),
    active: !!course.active,
    modules,
    lessons: lessons.map((l) => ({ ...l, duration_seconds: Number(l.duration_seconds) })),
    questions: questions.map((q) => ({
      id: q.id,
      question: q.question,
      options: parseOptions(q.options),
      points: Number(q.points),
      sort_order: Number(q.sort_order),
      ...(opts.includeAnswers ? { correct_index: Number(q.correct_index) } : {}),
    })),
  }
}

export async function createCourse(v: ValidatedCourse, session: SessionPayload) {
  await ensureTrainingSchema()
  const t = await tid()
  const res: any = await query(
    `INSERT INTO training_courses (tenant_id, code, title, description, category, roles, pass_score, due_days, active, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [t, v.code, v.title, v.description, v.category, JSON.stringify(v.roles), v.pass_score, v.due_days, v.active ? 1 : 0, session.userId, session.name],
  )
  const id = res.insertId as number
  await audit("training.course.create", "training_course", id, { entityLabel: v.title })
  return getCourseDetail(id, { includeAnswers: true })
}

export async function updateCourse(courseId: number, v: ValidatedCourse, session: SessionPayload) {
  await ensureTrainingSchema()
  const t = await tid()
  const res: any = await query(
    `UPDATE training_courses
        SET code = ?, title = ?, description = ?, category = ?, roles = ?, pass_score = ?, due_days = ?, active = ?
      WHERE tenant_id = ? AND id = ?`,
    [v.code, v.title, v.description, v.category, JSON.stringify(v.roles), v.pass_score, v.due_days, v.active ? 1 : 0, t, courseId],
  )
  if (!res.affectedRows) throw new TrainingError("Course not found", 404)
  await audit("training.course.update", "training_course", courseId, { entityLabel: v.title })
  return getCourseDetail(courseId, { includeAnswers: true })
}

export async function deleteCourse(courseId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const exists = (await query<any[]>(`SELECT id FROM training_courses WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, courseId]))[0]
  if (!exists) throw new TrainingError("Course not found", 404)
  const [{ c: assignmentCount }] = await query<any[]>(
    `SELECT COUNT(*) AS c FROM training_assignments WHERE tenant_id = ? AND course_id = ?`,
    [t, courseId],
  )
  if (Number(assignmentCount) > 0) {
    // Completion records and certificates are compliance evidence; deactivate instead.
    throw new TrainingError("Course has assignments; deactivate it instead of deleting", 409)
  }
  for (const tbl of ["training_lessons", "training_modules", "training_quiz_questions"]) {
    await query(`DELETE FROM ${tbl} WHERE tenant_id = ? AND course_id = ?`, [t, courseId])
  }
  await query(`DELETE FROM training_courses WHERE tenant_id = ? AND id = ?`, [t, courseId])
  await audit("training.course.delete", "training_course", courseId)
  return { ok: true }
}

// --- content authoring -----------------------------------------------------
export async function addModule(courseId: number, title: string, sortOrder = 0) {
  await ensureTrainingSchema()
  const t = await tid()
  await assertCourse(t, courseId)
  const res: any = await query(
    `INSERT INTO training_modules (tenant_id, course_id, title, sort_order) VALUES (?,?,?,?)`,
    [t, courseId, title.slice(0, 200), sortOrder],
  )
  await audit("training.module.create", "training_module", res.insertId, { metadata: { courseId } })
  return { id: res.insertId as number }
}

export async function addLesson(
  courseId: number,
  input: { title: string; lesson_type: LessonType; media_id?: number | null; content?: string | null; duration_seconds?: number; module_id?: number | null; sort_order?: number },
) {
  await ensureTrainingSchema()
  const t = await tid()
  await assertCourse(t, courseId)
  if (input.media_id != null) await assertMedia(t, input.media_id)
  const res: any = await query(
    `INSERT INTO training_lessons (tenant_id, course_id, module_id, title, lesson_type, media_id, content, duration_seconds, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      t,
      courseId,
      input.module_id ?? null,
      input.title.slice(0, 200),
      input.lesson_type,
      input.media_id ?? null,
      input.content ?? null,
      Math.max(0, Number(input.duration_seconds) || 0),
      Number(input.sort_order) || 0,
    ],
  )
  await audit("training.lesson.create", "training_lesson", res.insertId, { metadata: { courseId, type: input.lesson_type } })
  return { id: res.insertId as number }
}

export async function addQuestion(
  courseId: number,
  input: { question: string; options: string[]; correct_index: number; points?: number; sort_order?: number },
) {
  await ensureTrainingSchema()
  const t = await tid()
  await assertCourse(t, courseId)
  const options = input.options.map((o) => String(o)).filter((o) => o.trim().length > 0)
  if (options.length < 2) throw new TrainingError("A question needs at least two options")
  const correct = Number(input.correct_index)
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
    throw new TrainingError("correct_index is out of range")
  }
  const res: any = await query(
    `INSERT INTO training_quiz_questions (tenant_id, course_id, question, options, correct_index, points, sort_order)
     VALUES (?,?,?,?,?,?,?)`,
    [t, courseId, String(input.question).slice(0, 2000), JSON.stringify(options), correct, Math.max(1, Number(input.points) || 1), Number(input.sort_order) || 0],
  )
  await audit("training.question.create", "training_quiz_question", res.insertId, { metadata: { courseId } })
  return { id: res.insertId as number }
}

async function assertCourse(t: number, courseId: number) {
  const row = (await query<any[]>(`SELECT id FROM training_courses WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, courseId]))[0]
  if (!row) throw new TrainingError("Course not found", 404)
}

async function assertMedia(t: number, mediaId: number) {
  const row = (await query<any[]>(`SELECT id FROM training_media WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, mediaId]))[0]
  if (!row) throw new TrainingError("Media not found", 404)
}

// ---------------------------------------------------------------------------
// Assignment (by role / explicit employees) + tracking
// ---------------------------------------------------------------------------
export type AssignResult = {
  assigned: number
  skipped: number
  reassigned: number
  targeted: number
  outOfScope: number
  replayed: boolean
}

export async function assignCourse(
  courseId: number,
  opts: { roles?: string[]; employeeIds?: number[]; reassign?: boolean; idempotencyKey?: string | null },
  session: SessionPayload,
): Promise<AssignResult> {
  await ensureTrainingSchema()
  const t = await tid()
  const course = (await query<any[]>(`SELECT * FROM training_courses WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, courseId]))[0]
  if (!course) throw new TrainingError("Course not found", 404)

  const configuredRoles = parseStringArray(course.roles)
  const roles = opts.roles && opts.roles.length ? opts.roles : configuredRoles
  const explicit = (opts.employeeIds ?? []).filter((n) => Number.isInteger(n))

  if (!course.active) throw new TrainingError("Course is inactive", 409)

  const key = opts.idempotencyKey ? String(opts.idempotencyKey).slice(0, 80) : null
  if (key) {
    const [{ c }] = await query<any[]>(
      `SELECT COUNT(*) AS c FROM training_assignments WHERE tenant_id = ? AND course_id = ? AND idempotency_key = ?`,
      [t, courseId, key],
    )
    if (Number(c) > 0) {
      return { assigned: 0, skipped: 0, reassigned: 0, targeted: 0, outOfScope: 0, replayed: true }
    }
  }

  const employees = await listTenantEmployees(t)
  const inScope = new Set(employees.map((e) => e.id))
  const outOfScope = explicit.filter((id) => !inScope.has(id)).length
  const targets = employees.filter((e) => {
    if (explicit.length && explicit.includes(e.id)) return true
    if (explicit.length && !(opts.roles && opts.roles.length)) return false
    return roleMatches(roles, { designation: e.designation })
  })

  const dueDate = course.due_days != null ? isoDatePlusDays(Number(course.due_days)) : null

  let assigned = 0
  let skipped = 0
  let reassigned = 0
  const followUps: { userId: number; assignmentId: number }[] = []
  for (const e of targets) {
    const existing = (await query<any[]>(
      `SELECT id, status FROM training_assignments WHERE tenant_id = ? AND course_id = ? AND employee_id = ? LIMIT 1`,
      [t, courseId, e.id],
    ))[0]
    if (existing) {
      if (opts.reassign) {
        await query(
          `UPDATE training_assignments
              SET status = 'assigned', due_date = ?, started_at = NULL, completed_at = NULL,
                  score = NULL, passed = NULL, reassigned_count = reassigned_count + 1, assigned_by = ?,
                  assigned_at = CURRENT_TIMESTAMP, idempotency_key = COALESCE(?, idempotency_key)
            WHERE tenant_id = ? AND id = ?`,
          [dueDate, session.userId, key, t, existing.id],
        )
        // A reassignment restarts the course: clear prior progress and the
        // active certificate. Quiz attempts stay as immutable history.
        await query(`DELETE FROM training_lesson_progress WHERE tenant_id = ? AND assignment_id = ?`, [t, existing.id])
        await query(`DELETE FROM training_certificates WHERE tenant_id = ? AND assignment_id = ?`, [t, existing.id])
        followUps.push({ userId: e.user_id, assignmentId: Number(existing.id) })
        reassigned += 1
      } else {
        skipped += 1
      }
      continue
    }
    const res: any = await query(
      `INSERT IGNORE INTO training_assignments (tenant_id, course_id, employee_id, employee_name, assigned_role, status, due_date, assigned_by, idempotency_key)
       VALUES (?,?,?,?,?, 'assigned', ?, ?, ?)`,
      [t, courseId, e.id, e.employee_name ?? null, e.designation ?? null, dueDate, session.userId, key],
    )
    if (res?.affectedRows) {
      followUps.push({ userId: e.user_id, assignmentId: Number(res.insertId) })
      assigned += 1
    } else {
      skipped += 1 // concurrent request inserted it first
    }
  }

  for (const f of followUps) {
    await createAssignmentTask({ userId: f.userId, courseTitle: course.title, dueDate, assignmentId: f.assignmentId })
  }

  await audit("training.course.assign", "training_course", courseId, {
    entityLabel: course.title,
    metadata: { assigned, skipped, reassigned, targeted: targets.length, outOfScope, roles, reassign: !!opts.reassign },
  })
  return { assigned, skipped, reassigned, targeted: targets.length, outOfScope, replayed: false }
}

export async function listMyAssignments(employeeId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const rows = await query<any[]>(
    `SELECT a.*, c.title AS course_title, c.category, c.pass_score,
        (SELECT COUNT(*) FROM training_lessons tl WHERE tl.tenant_id = a.tenant_id AND tl.course_id = a.course_id) AS total_lessons,
        (SELECT COUNT(*) FROM training_lesson_progress tp WHERE tp.tenant_id = a.tenant_id AND tp.assignment_id = a.id) AS done_lessons,
        (SELECT cert.certificate_no FROM training_certificates cert WHERE cert.tenant_id = a.tenant_id AND cert.assignment_id = a.id) AS certificate_no
       FROM training_assignments a
       JOIN training_courses c ON c.tenant_id = a.tenant_id AND c.id = a.course_id
      WHERE a.tenant_id = ? AND a.employee_id = ?
      ORDER BY a.assigned_at DESC`,
    [t, employeeId],
  )
  return rows.map(decorateAssignment)
}

export async function listCourseAssignments(courseId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const rows = await query<any[]>(
    `SELECT a.*,
        (SELECT COUNT(*) FROM training_lessons tl WHERE tl.tenant_id = a.tenant_id AND tl.course_id = a.course_id) AS total_lessons,
        (SELECT COUNT(*) FROM training_lesson_progress tp WHERE tp.tenant_id = a.tenant_id AND tp.assignment_id = a.id) AS done_lessons
       FROM training_assignments a
      WHERE a.tenant_id = ? AND a.course_id = ?
      ORDER BY a.assigned_at DESC`,
    [t, courseId],
  )
  return rows.map(decorateAssignment)
}

function decorateAssignment(r: any) {
  const effectiveStatus = deriveStatus(
    { status: r.status, due_date: r.due_date, completed_at: r.completed_at },
    new Date(),
  )
  return {
    ...r,
    passed: r.passed == null ? null : !!r.passed,
    total_lessons: Number(r.total_lessons ?? 0),
    done_lessons: Number(r.done_lessons ?? 0),
    effective_status: effectiveStatus,
  }
}

/** Learner view of a single assignment (no quiz answers). */
export async function getAssignmentForLearner(assignmentId: number, employeeId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const a = (await query<any[]>(
    `SELECT * FROM training_assignments WHERE tenant_id = ? AND id = ? AND employee_id = ? LIMIT 1`,
    [t, assignmentId, employeeId],
  ))[0]
  if (!a) throw new TrainingError("Assignment not found", 404)
  const course = await getCourseDetail(a.course_id, { includeAnswers: false })
  const progress = await query<any[]>(
    `SELECT lesson_id, completed_at FROM training_lesson_progress WHERE tenant_id = ? AND assignment_id = ?`,
    [t, assignmentId],
  )
  const cert = (await query<any[]>(
    `SELECT * FROM training_certificates WHERE tenant_id = ? AND assignment_id = ? LIMIT 1`,
    [t, assignmentId],
  ))[0]
  return {
    assignment: decorateAssignment(a),
    course,
    completedLessonIds: progress.map((p) => Number(p.lesson_id)),
    certificate: cert ?? null,
  }
}

export async function markLessonComplete(assignmentId: number, lessonId: number, employeeId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const a = (await query<any[]>(
    `SELECT * FROM training_assignments WHERE tenant_id = ? AND id = ? AND employee_id = ? LIMIT 1`,
    [t, assignmentId, employeeId],
  ))[0]
  if (!a) throw new TrainingError("Assignment not found", 404)
  const lesson = (await query<any[]>(
    `SELECT id, lesson_type, media_id FROM training_lessons WHERE tenant_id = ? AND id = ? AND course_id = ? LIMIT 1`,
    [t, lessonId, a.course_id],
  ))[0]
  if (!lesson) throw new TrainingError("Lesson not found", 404)
  const media = lesson.media_id != null
    ? (await query<any[]>(
        `SELECT id, expires_at FROM training_media WHERE tenant_id = ? AND id = ? LIMIT 1`,
        [t, lesson.media_id],
      ))[0] ?? null
    : null
  const gate = lessonCompletable({ lessonType: lesson.lesson_type, mediaId: lesson.media_id, media })
  if (!gate.ok) {
    await audit("training.lesson.complete", "training_lesson", lessonId, {
      result: "denied",
      metadata: { assignmentId, reason: gate.reason },
    })
    throw new TrainingError(
      gate.reason === "media_expired"
        ? "This lesson's media has expired and cannot be completed. Ask HR to refresh it."
        : "This lesson's media is unavailable and cannot be completed.",
      409,
    )
  }
  await query(
    `INSERT IGNORE INTO training_lesson_progress (tenant_id, assignment_id, lesson_id) VALUES (?,?,?)`,
    [t, assignmentId, lessonId],
  )
  if (a.status === "assigned") {
    await query(
      `UPDATE training_assignments SET status = 'started', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE tenant_id = ? AND id = ?`,
      [t, assignmentId],
    )
  }
  await maybeComplete(t, assignmentId)
  return { ok: true }
}

export type QuizSubmission = { answers: Record<string, number> }

export async function submitQuiz(assignmentId: number, submission: QuizSubmission, employeeId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const a = (await query<any[]>(
    `SELECT * FROM training_assignments WHERE tenant_id = ? AND id = ? AND employee_id = ? LIMIT 1`,
    [t, assignmentId, employeeId],
  ))[0]
  if (!a) throw new TrainingError("Assignment not found", 404)
  const course = (await query<any[]>(`SELECT * FROM training_courses WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, a.course_id]))[0]
  if (!course) throw new TrainingError("Course not found", 404)
  const questions = await query<any[]>(
    `SELECT id, correct_index, points FROM training_quiz_questions WHERE tenant_id = ? AND course_id = ?`,
    [t, a.course_id],
  )
  if (questions.length === 0) throw new TrainingError("This course has no quiz")

  const result = scoreQuiz(
    questions.map((q) => ({ id: Number(q.id), correct_index: Number(q.correct_index), points: Number(q.points) })),
    submission.answers ?? {},
    Number(course.pass_score),
  )

  await query(
    `INSERT INTO training_quiz_attempts (tenant_id, assignment_id, course_id, employee_id, score, passed, answers)
     VALUES (?,?,?,?,?,?,?)`,
    [t, assignmentId, a.course_id, employeeId, result.score, result.passed ? 1 : 0, JSON.stringify(submission.answers ?? {})],
  )
  await query(
    `UPDATE training_assignments
        SET score = ?, passed = ?, attempts = attempts + 1,
            status = CASE WHEN status = 'assigned' THEN 'started' ELSE status END,
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
      WHERE tenant_id = ? AND id = ?`,
    [result.score, result.passed ? 1 : 0, t, assignmentId],
  )
  await audit("training.quiz.submit", "training_assignment", assignmentId, {
    metadata: { courseId: a.course_id, score: result.score, passed: result.passed },
  })
  const completion = await maybeComplete(t, assignmentId)
  return { result, ...completion }
}

/**
 * Apply the completion rule: all lessons done AND (no quiz OR quiz passed).
 * Issues a certificate exactly once (idempotent via uq_training_cert).
 */
async function maybeComplete(t: number, assignmentId: number): Promise<{ completed: boolean; certificate_no: string | null }> {
  const a = (await query<any[]>(`SELECT * FROM training_assignments WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, assignmentId]))[0]
  if (!a) return { completed: false, certificate_no: null }
  const [{ c: totalLessons }] = await query<any[]>(
    `SELECT COUNT(*) AS c FROM training_lessons WHERE tenant_id = ? AND course_id = ?`,
    [t, a.course_id],
  )
  const [{ c: doneLessons }] = await query<any[]>(
    `SELECT COUNT(*) AS c FROM training_lesson_progress WHERE tenant_id = ? AND assignment_id = ?`,
    [t, assignmentId],
  )
  const [{ c: totalQuestions }] = await query<any[]>(
    `SELECT COUNT(*) AS c FROM training_quiz_questions WHERE tenant_id = ? AND course_id = ?`,
    [t, a.course_id],
  )
  const hasQuiz = Number(totalQuestions) > 0
  const done = meetsCompletionRule({
    totalLessons: Number(totalLessons),
    completedLessons: Number(doneLessons),
    hasQuiz,
    quizPassed: !!a.passed,
  })
  if (!done) return { completed: false, certificate_no: null }

  if (a.status !== "completed") {
    await query(
      `UPDATE training_assignments SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE tenant_id = ? AND id = ?`,
      [t, assignmentId],
    )
  }
  const existingCert = (await query<any[]>(
    `SELECT certificate_no FROM training_certificates WHERE tenant_id = ? AND assignment_id = ? LIMIT 1`,
    [t, assignmentId],
  ))[0]
  if (existingCert) return { completed: true, certificate_no: existingCert.certificate_no }

  const course = (await query<any[]>(`SELECT title FROM training_courses WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, a.course_id]))[0]
  const certNo = certificateNumber(assignmentId)
  await query(
    `INSERT IGNORE INTO training_certificates (tenant_id, assignment_id, course_id, employee_id, employee_name, course_title, certificate_no, score)
     VALUES (?,?,?,?,?,?,?,?)`,
    [t, assignmentId, a.course_id, a.employee_id, a.employee_name, course?.title ?? null, certNo, a.score],
  )
  await audit("training.certificate.issue", "training_certificate", assignmentId, { entityLabel: certNo })
  const saved = (await query<any[]>(
    `SELECT certificate_no FROM training_certificates WHERE tenant_id = ? AND assignment_id = ? LIMIT 1`,
    [t, assignmentId],
  ))[0]
  return { completed: true, certificate_no: saved?.certificate_no ?? certNo }
}

// ---------------------------------------------------------------------------
// Media (central private storage references + access control)
// ---------------------------------------------------------------------------
export async function registerMedia(
  input: { storage_key: string; file_name?: string | null; mime?: string | null; size?: number; access?: MediaAccess; expires_at?: string | null },
  session: SessionPayload,
) {
  await ensureTrainingSchema()
  const t = await tid()
  if (!input.storage_key) throw new TrainingError("storage_key is required")
  // Only objects inside this tenant's private-storage namespace may be referenced.
  if (!keyBelongsToTenant(input.storage_key, t)) {
    await audit("training.media.register", "training_media", null, { result: "denied", metadata: { reason: "foreign_key" } })
    throw new TrainingError("storage_key does not belong to this tenant", 403)
  }
  const expires = parseExpiry(input.expires_at)
  const res: any = await query(
    `INSERT INTO training_media (tenant_id, storage_key, file_name, mime, size, access, expires_at, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      t,
      input.storage_key.slice(0, 1024),
      input.file_name?.slice(0, 255) ?? null,
      input.mime?.slice(0, 150) ?? null,
      Math.max(0, Number(input.size) || 0),
      input.access === "tenant" ? "tenant" : "assigned",
      expires,
      session.userId,
    ],
  )
  await audit("training.media.register", "training_media", res.insertId, { entityLabel: input.file_name ?? null })
  return { id: res.insertId as number }
}

function parseExpiry(raw: string | null | undefined): Date | null {
  if (raw == null || raw === "") return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) throw new TrainingError("expires_at is not a valid date")
  if (d.getTime() <= Date.now()) throw new TrainingError("expires_at must be in the future")
  return d
}

const MEDIA_MIME = /^(video\/|application\/pdf$|application\/vnd\.openxmlformats-officedocument\.|application\/msword$|application\/vnd\.ms-powerpoint$|text\/plain$)/

/**
 * Upload a lesson video/document into central private storage (tenant-
 * namespaced key, quota, malware scan, file_objects metadata) and register it.
 */
export async function uploadTrainingMedia(
  file: File,
  opts: { access?: MediaAccess; expires_at?: string | null },
  session: SessionPayload,
) {
  await ensureTrainingSchema()
  await tid()
  if (!file.size) throw new TrainingError("File is empty")
  if (!MEDIA_MIME.test(file.type || "")) throw new TrainingError("Only video, PDF, Office or text documents are allowed")
  parseExpiry(opts.expires_at) // validate before storing bytes
  const up = await uploadFile(`training/${randomUUID()}-${file.name}`, file, {
    metadata: { module: "training", entityType: "training_media", ownerId: session.userId, classification: "internal" },
  })
  if (!up.ok) throw new TrainingError(up.error, 400)
  const media = await registerMedia(
    { storage_key: up.result.key, file_name: file.name, mime: file.type, size: file.size, access: opts.access, expires_at: opts.expires_at },
    session,
  )
  return { ...media, file_name: file.name, mime: file.type, size: file.size }
}

export async function listMedia() {
  await ensureTrainingSchema()
  const t = await tid()
  const rows = await query<any[]>(
    `SELECT id, file_name, mime, size, access, expires_at, created_at FROM training_media WHERE tenant_id = ? ORDER BY created_at DESC`,
    [t],
  )
  return rows.map((m) => ({ ...m, size: Number(m.size), expired: isMediaExpired(m.expires_at) }))
}

/**
 * Resolve a short-lived signed URL for a media object after enforcing intra-
 * tenant access control + expiry. Managers always pass; learners must be
 * assigned to a course that uses the media (for `assigned` access).
 */
export async function getMediaAccessUrl(mediaId: number, session: SessionPayload, isManager: boolean) {
  await ensureTrainingSchema()
  const t = await tid()
  const media = (await query<any[]>(`SELECT * FROM training_media WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, mediaId]))[0]
  if (!media) throw new TrainingError("Media not found", 404)

  const mediaCourses = await query<any[]>(
    `SELECT DISTINCT course_id FROM training_lessons WHERE tenant_id = ? AND media_id = ?`,
    [t, mediaId],
  )
  const mediaCourseIds = mediaCourses.map((r) => Number(r.course_id))

  let employeeCourseIds: number[] = []
  if (!isManager) {
    const emp = await resolveEmployee(session)
    if (emp) {
      const rows = await query<any[]>(
        `SELECT course_id FROM training_assignments WHERE tenant_id = ? AND employee_id = ?`,
        [t, emp.id],
      )
      employeeCourseIds = rows.map((r) => Number(r.course_id))
    }
  }

  const decision = canAccessMedia({
    access: media.access,
    expiresAt: media.expires_at,
    isManager,
    mediaCourseIds,
    employeeCourseIds,
  })
  if (!decision.allowed) {
    await audit("training.media.access", "training_media", mediaId, { result: "denied", metadata: { reason: decision.reason } })
    throw new TrainingError(
      decision.reason === "expired" ? "This media has expired" : "You do not have access to this media",
      decision.reason === "expired" ? 410 : 403,
    )
  }
  const url = await getSignedDownloadUrl(media.storage_key, { expiresIn: 300 })
  await audit("training.media.access", "training_media", mediaId, { result: "success" })
  return { url, file_name: media.file_name, mime: media.mime, expires_in: 300 }
}

// ---------------------------------------------------------------------------
// Policies + acknowledgment
// ---------------------------------------------------------------------------
export async function listPolicies(employeeId: number | null) {
  await ensureTrainingSchema()
  const t = await tid()
  const rows = await query<any[]>(
    `SELECT p.*,
        (SELECT COUNT(*) FROM training_policy_acknowledgments a WHERE a.tenant_id = p.tenant_id AND a.policy_id = p.id AND a.version = p.current_version) AS ack_count,
        (SELECT pv.summary FROM training_policy_versions pv WHERE pv.tenant_id = p.tenant_id AND pv.policy_id = p.id AND pv.version = p.current_version LIMIT 1) AS current_summary
       FROM training_policies p
      WHERE p.tenant_id = ?
      ORDER BY p.updated_at DESC`,
    [t],
  )
  let ackMap = new Map<number, number>()
  if (employeeId != null && rows.length) {
    const acks = await query<any[]>(
      `SELECT policy_id, version FROM training_policy_acknowledgments WHERE tenant_id = ? AND employee_id = ?`,
      [t, employeeId],
    )
    ackMap = new Map(acks.map((a) => [Number(a.policy_id), Number(a.version)]))
  }
  return rows.map((p) => ({
    ...p,
    active: !!p.active,
    ack_count: Number(p.ack_count ?? 0),
    acknowledged_current: employeeId != null && ackMap.get(Number(p.id)) === Number(p.current_version),
  }))
}

export async function getPolicyDetail(policyId: number, employeeId: number | null) {
  await ensureTrainingSchema()
  const t = await tid()
  const policy = (await query<any[]>(`SELECT * FROM training_policies WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, policyId]))[0]
  if (!policy) throw new TrainingError("Policy not found", 404)
  const versions = await query<any[]>(
    `SELECT * FROM training_policy_versions WHERE tenant_id = ? AND policy_id = ? ORDER BY version DESC`,
    [t, policyId],
  )
  const current = versions.find((v) => Number(v.version) === Number(policy.current_version)) ?? versions[0] ?? null
  let myAck: any = null
  if (employeeId != null) {
    myAck = (await query<any[]>(
      `SELECT * FROM training_policy_acknowledgments WHERE tenant_id = ? AND policy_id = ? AND employee_id = ? ORDER BY version DESC LIMIT 1`,
      [t, policyId, employeeId],
    ))[0] ?? null
  }
  return {
    ...policy,
    active: !!policy.active,
    versions,
    current,
    myAck,
    acknowledged_current: !!myAck && Number(myAck.version) === Number(policy.current_version),
  }
}

export async function createPolicy(v: ValidatedPolicy, session: SessionPayload) {
  await ensureTrainingSchema()
  const t = await tid()
  const res: any = await query(
    `INSERT INTO training_policies (tenant_id, code, title, category, current_version, created_by, created_by_name)
     VALUES (?,?,?,?,1,?,?)`,
    [t, v.code, v.title, v.category, session.userId, session.name],
  )
  const policyId = res.insertId as number
  await query(
    `INSERT INTO training_policy_versions (tenant_id, policy_id, version, body, summary, effective_date, published_by, published_by_name)
     VALUES (?,?,1,?,?,?,?,?)`,
    [t, policyId, v.body, v.summary, v.effective_date, session.userId, session.name],
  )
  await audit("training.policy.create", "training_policy", policyId, { entityLabel: v.title })
  return getPolicyDetail(policyId, null)
}

/** Publish a new immutable version; supersedes prior acknowledgments. */
export async function publishPolicyVersion(
  policyId: number,
  v: ValidatedPolicy,
  session: SessionPayload,
  idempotencyKey: string | null = null,
) {
  await ensureTrainingSchema()
  const t = await tid()
  const policy = (await query<any[]>(`SELECT * FROM training_policies WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, policyId]))[0]
  if (!policy) throw new TrainingError("Policy not found", 404)
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 80) : null
  if (key) {
    const prior = (await query<any[]>(
      `SELECT version FROM training_policy_versions WHERE tenant_id = ? AND policy_id = ? AND idempotency_key = ? LIMIT 1`,
      [t, policyId, key],
    ))[0]
    if (prior) return { ...(await getPolicyDetail(policyId, null)), replayed: true, published_version: Number(prior.version) }
  }
  const nextVersion = Number(policy.current_version) + 1
  try {
    await query(
      `INSERT INTO training_policy_versions (tenant_id, policy_id, version, body, summary, effective_date, published_by, published_by_name, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [t, policyId, nextVersion, v.body, v.summary, v.effective_date, session.userId, session.name, key],
    )
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY") {
      throw new TrainingError("Another version was published at the same time; reload and try again", 409)
    }
    throw err
  }
  // Guarded compare-and-set so a concurrent publish cannot move the pointer backwards.
  await query(
    `UPDATE training_policies SET current_version = ?, title = ?, category = ?
      WHERE tenant_id = ? AND id = ? AND current_version < ?`,
    [nextVersion, v.title, v.category, t, policyId, nextVersion],
  )
  await audit("training.policy.publish", "training_policy", policyId, {
    entityLabel: v.title,
    metadata: { version: nextVersion, previousVersion: Number(policy.current_version) },
  })

  // Every prior acknowledgment is now outdated — ask employees to re-acknowledge.
  const employees = await listTenantEmployees(t)
  await notifyUsers(
    t,
    employees.map((e) => ({
      userId: e.user_id,
      key: `training:policy:${policyId}:v${nextVersion}:u${e.user_id}`,
      title: `Policy updated: ${v.title}`,
      body: `Version ${nextVersion} has been published. Please read and acknowledge it.`,
      link: "/modules/hr/policies",
    })),
  )
  return { ...(await getPolicyDetail(policyId, null)), replayed: false, published_version: nextVersion }
}

export type AckResult = { acknowledged: boolean; replayed: boolean; version: number; certificateEvidenceHash: string }

/**
 * Record an employee's acknowledgment of the policy's CURRENT version, with the
 * capture time and evidence. Idempotent: a repeat acknowledgment of the same
 * version by the same employee is a replay, never a duplicate.
 */
export async function acknowledgePolicy(
  policyId: number,
  input: {
    evidence: { ip?: string | null; userAgent?: string | null }
    idempotencyKey?: string | null
    readVersion?: unknown
  },
  session: SessionPayload,
  employee: EmployeeIdentity,
): Promise<AckResult> {
  await ensureTrainingSchema()
  const t = await tid()
  const policy = (await query<any[]>(`SELECT * FROM training_policies WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, policyId]))[0]
  if (!policy) throw new TrainingError("Policy not found", 404)
  if (!policy.active) throw new TrainingError("Policy is inactive", 409)
  const version = Number(policy.current_version)
  if (ackVersionConflict(version, input.readVersion)) {
    await audit("training.policy.acknowledge", "training_policy", policyId, {
      result: "denied",
      metadata: { reason: "stale_version", readVersion: input.readVersion, currentVersion: version, employeeId: employee.id },
    })
    throw new TrainingError(`This policy was updated to version ${version}. Please read the latest version before acknowledging.`, 409)
  }

  const existing = (await query<any[]>(
    `SELECT * FROM training_policy_acknowledgments WHERE tenant_id = ? AND policy_id = ? AND version = ? AND employee_id = ? LIMIT 1`,
    [t, policyId, version, employee.id],
  ))[0]
  const evidence: Evidence = normalizeEvidence({ ip: input.evidence.ip, userAgent: input.evidence.userAgent })
  const evidenceHash = createHash("sha256")
    .update(`${t}:${policyId}:${version}:${employee.id}:${evidence.ip ?? ""}:${evidence.userAgent ?? ""}:${evidence.capturedAt}`)
    .digest("hex")

  if (existing) {
    return { acknowledged: true, replayed: true, version, certificateEvidenceHash: evidenceHash }
  }

  await query(
    `INSERT IGNORE INTO training_policy_acknowledgments (tenant_id, policy_id, version, employee_id, employee_name, evidence, idempotency_key)
     VALUES (?,?,?,?,?,?,?)`,
    [t, policyId, version, employee.id, employee.employee_name, JSON.stringify({ ...evidence, hash: evidenceHash }), input.idempotencyKey ?? randomUUID()],
  )
  await audit("training.policy.acknowledge", "training_policy", policyId, {
    entityLabel: policy.title,
    metadata: { version, employeeId: employee.id, evidenceHash },
  })
  return { acknowledged: true, replayed: false, version, certificateEvidenceHash: evidenceHash }
}

export async function listPolicyAcknowledgments(policyId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const policy = (await query<any[]>(`SELECT id FROM training_policies WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, policyId]))[0]
  if (!policy) throw new TrainingError("Policy not found", 404)
  return query<any[]>(
    `SELECT id, version, employee_id, employee_name, acknowledged_at, evidence
       FROM training_policy_acknowledgments
      WHERE tenant_id = ? AND policy_id = ?
      ORDER BY acknowledged_at DESC`,
    [t, policyId],
  )
}

/** Per-employee acknowledgment state for the current version (compliance roster). */
export async function listPolicyRoster(policyId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  const policy = (await query<any[]>(`SELECT id, current_version FROM training_policies WHERE tenant_id = ? AND id = ? LIMIT 1`, [t, policyId]))[0]
  if (!policy) throw new TrainingError("Policy not found", 404)
  const current = Number(policy.current_version)
  const acks = await query<any[]>(
    `SELECT employee_id, MAX(version) AS version, MAX(acknowledged_at) AS acknowledged_at
       FROM training_policy_acknowledgments WHERE tenant_id = ? AND policy_id = ? GROUP BY employee_id`,
    [t, policyId],
  )
  const byEmp = new Map(acks.map((a) => [Number(a.employee_id), a]))
  const employees = await listTenantEmployees(t)
  const rows = employees.map((e) => {
    const a = byEmp.get(e.id)
    const latest = a ? Number(a.version) : null
    return {
      employee_id: e.id,
      employee_name: e.employee_name,
      designation: e.designation,
      latest_version: latest,
      acknowledged_at: a?.acknowledged_at ?? null,
      state: policyAckState(current, latest),
    }
  })
  const summary = { current: 0, outdated: 0, pending: 0 }
  for (const r of rows) summary[r.state] += 1
  return { current_version: current, summary, rows }
}

export async function listMyCertificates(employeeId: number) {
  await ensureTrainingSchema()
  const t = await tid()
  return query<any[]>(
    `SELECT id, assignment_id, course_id, course_title, certificate_no, score, issued_at
       FROM training_certificates WHERE tenant_id = ? AND employee_id = ? ORDER BY issued_at DESC`,
    [t, employeeId],
  )
}

// ---------------------------------------------------------------------------
function isoDatePlusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
