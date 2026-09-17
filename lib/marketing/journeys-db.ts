import "server-only"
import { query } from "@/lib/db"

/**
 * Marketing Journeys — data layer.
 *
 * A "journey" is an automated, multi-step marketing workflow that enrolls
 * `marketing_contacts` and walks each one through an ordered list of steps
 * (send email, send WhatsApp, wait, branch, tag, notify, …). It reuses the
 * existing marketing contact master, the shared email transport + templates,
 * and the WhatsApp Cloud API integration.
 *
 * Schema is self-healing at runtime (CREATE TABLE IF NOT EXISTS + additive
 * ALTERs), matching the pattern used by contacts-db / lead-lifecycle so the
 * module works on a fresh database and upgrades an older one in place.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JourneyStatus = "Draft" | "Active" | "Paused" | "Completed" | "Archived"

export type TriggerType =
  | "contact_added"
  | "tag_added"
  | "segment_entered"
  | "form_submitted"
  | "lead_created"
  | "manual"

export type StepType =
  | "email"
  | "whatsapp"
  | "wait"
  | "branch"
  | "add_tag"
  | "remove_tag"
  | "add_segment"
  | "remove_segment"
  | "assign_owner"
  | "notification"
  | "create_task"
  | "goal"
  | "end"

export type EnrollmentStatus = "Active" | "Waiting" | "Completed" | "Paused" | "Exited" | "Failed"

export type JourneyRow = {
  id: number
  journey_code: string
  name: string
  description: string | null
  status: JourneyStatus
  trigger_type: TriggerType
  trigger_config: any
  audience_config: any
  goal_type: string | null
  goal_config: any
  owner_id: number | null
  allow_reentry: number
  allow_multiple_active: number
  quiet_hours_start: number | null
  quiet_hours_end: number | null
  start_at: string | null
  end_at: string | null
  activated_at: string | null
  archived_at: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

export type JourneyStepRow = {
  id: number
  journey_id: number
  step_order: number
  type: StepType
  name: string | null
  config: any
  enabled: number
  created_at: string
  updated_at: string
}

export type EnrollmentRow = {
  id: number
  enrollment_code: string
  journey_id: number
  contact_id: number
  status: EnrollmentStatus
  current_step_order: number
  next_run_at: string | null
  goal_reached: number
  exit_reason: string | null
  source: string
  attempt_count: number
  locked_at: string | null
  started_at: string
  last_action_at: string | null
  completed_at: string | null
  enrolled_by: number | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Schema self-heal
// ---------------------------------------------------------------------------

let ensured = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumnIfMissing(table: string, column: string, ddl: string) {
  if (await columnExists(table, column)) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {})
}

export async function ensureJourneySchema() {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_journeys (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      journey_code VARCHAR(40) NOT NULL,
      name VARCHAR(190) NOT NULL,
      description VARCHAR(500) NULL,
      status ENUM('Draft','Active','Paused','Completed','Archived') NOT NULL DEFAULT 'Draft',
      trigger_type VARCHAR(40) NOT NULL DEFAULT 'manual',
      trigger_config JSON NULL,
      audience_config JSON NULL,
      goal_type VARCHAR(40) NULL,
      goal_config JSON NULL,
      owner_id INT UNSIGNED NULL,
      allow_reentry TINYINT(1) NOT NULL DEFAULT 0,
      allow_multiple_active TINYINT(1) NOT NULL DEFAULT 0,
      quiet_hours_start INT NULL,
      quiet_hours_end INT NULL,
      start_at DATETIME NULL,
      end_at DATETIME NULL,
      activated_at DATETIME NULL,
      archived_at DATETIME NULL,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_journey_code (journey_code),
      KEY idx_j_status (status),
      KEY idx_j_trigger (trigger_type),
      KEY idx_j_owner (owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_journey_steps (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      journey_id BIGINT UNSIGNED NOT NULL,
      step_order INT NOT NULL DEFAULT 0,
      type VARCHAR(40) NOT NULL,
      name VARCHAR(190) NULL,
      config JSON NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_js_journey (journey_id),
      KEY idx_js_order (journey_id, step_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_journey_enrollments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      enrollment_code VARCHAR(40) NOT NULL,
      journey_id BIGINT UNSIGNED NOT NULL,
      contact_id BIGINT UNSIGNED NOT NULL,
      status ENUM('Active','Waiting','Completed','Paused','Exited','Failed') NOT NULL DEFAULT 'Active',
      current_step_order INT NOT NULL DEFAULT 0,
      next_run_at DATETIME NULL,
      goal_reached TINYINT(1) NOT NULL DEFAULT 0,
      exit_reason VARCHAR(190) NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'trigger',
      attempt_count INT NOT NULL DEFAULT 0,
      locked_at DATETIME NULL,
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_action_at DATETIME NULL,
      completed_at DATETIME NULL,
      enrolled_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_enrollment_code (enrollment_code),
      KEY idx_je_journey (journey_id),
      KEY idx_je_contact (contact_id),
      KEY idx_je_status (status),
      KEY idx_je_due (status, next_run_at),
      KEY idx_je_active (journey_id, contact_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_journey_step_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      enrollment_id BIGINT UNSIGNED NOT NULL,
      journey_id BIGINT UNSIGNED NOT NULL,
      step_id BIGINT UNSIGNED NULL,
      step_order INT NOT NULL DEFAULT 0,
      contact_id BIGINT UNSIGNED NOT NULL,
      type VARCHAR(40) NOT NULL,
      status ENUM('Completed','Skipped','Failed') NOT NULL DEFAULT 'Completed',
      idempotency_key VARCHAR(120) NOT NULL,
      result JSON NULL,
      error VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_step_run (idempotency_key),
      KEY idx_jsr_enrollment (enrollment_id),
      KEY idx_jsr_journey (journey_id),
      KEY idx_jsr_type (type),
      KEY idx_jsr_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_journey_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      journey_id BIGINT UNSIGNED NULL,
      enrollment_id BIGINT UNSIGNED NULL,
      contact_id BIGINT UNSIGNED NULL,
      step_id BIGINT UNSIGNED NULL,
      action VARCHAR(60) NOT NULL,
      detail VARCHAR(500) NULL,
      meta JSON NULL,
      actor_id INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_jev_journey (journey_id),
      KEY idx_jev_enrollment (enrollment_id),
      KEY idx_jev_contact (contact_id),
      KEY idx_jev_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_journey_event_dedup (
      event_key VARCHAR(191) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  try {
    await addColumnIfMissing("marketing_journeys", "quiet_hours_start", "`quiet_hours_start` INT NULL")
    await addColumnIfMissing("marketing_journeys", "quiet_hours_end", "`quiet_hours_end` INT NULL")
    await addColumnIfMissing("marketing_journeys", "goal_type", "`goal_type` VARCHAR(40) NULL")
    await addColumnIfMissing("marketing_journeys", "goal_config", "`goal_config` JSON NULL")
  } catch (error) {
    console.error("[journeys-db] self-heal failed", error)
  }

  // Register module features so the permission matrix can gate this screen.
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Journeys','marketing.journeys.view','View marketing automation journeys',80 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Manage Journeys','marketing.journeys.manage','Create, edit, activate and enroll into journeys',81 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})

  ensured = true
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function randomSuffix(len = 5): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let out = ""
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export function newJourneyCode(): string {
  return `JRN-${randomSuffix(6)}`
}

export function newEnrollmentCode(): string {
  return `JEN-${Date.now().toString(36).toUpperCase()}-${randomSuffix(4)}`
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function recordJourneyEvent(input: {
  journeyId?: number | null
  enrollmentId?: number | null
  contactId?: number | null
  stepId?: number | null
  action: string
  detail?: string | null
  meta?: Record<string, any> | null
  actorId?: number | null
}): Promise<void> {
  await query(
    `INSERT INTO marketing_journey_events
       (journey_id, enrollment_id, contact_id, step_id, action, detail, meta, actor_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      input.journeyId ?? null,
      input.enrollmentId ?? null,
      input.contactId ?? null,
      input.stepId ?? null,
      input.action.slice(0, 60),
      input.detail ? input.detail.slice(0, 500) : null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.actorId ?? null,
    ],
  ).catch((e) => console.error("[journeys-db] recordJourneyEvent failed", e))
}

// ---------------------------------------------------------------------------
// JSON coercion helper (mysql2 may return JSON columns as strings)
// ---------------------------------------------------------------------------

export function parseJson<T = any>(value: any, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Journey CRUD
// ---------------------------------------------------------------------------

export async function getJourney(id: number): Promise<JourneyRow | null> {
  const rows = await query<any[]>(`SELECT * FROM marketing_journeys WHERE id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

export async function getJourneySteps(journeyId: number): Promise<JourneyStepRow[]> {
  return query<any[]>(
    `SELECT * FROM marketing_journey_steps WHERE journey_id = ? ORDER BY step_order ASC, id ASC`,
    [journeyId],
  )
}

export type JourneyListItem = JourneyRow & {
  step_count: number
  total_enrolled: number
  active_enrolled: number
  completed_enrolled: number
  owner_name: string | null
}

export async function listJourneys(opts: {
  search?: string
  status?: string
  trigger?: string
  sort?: string
  page?: number
  pageSize?: number
}): Promise<{ items: JourneyListItem[]; total: number }> {
  const where: string[] = []
  const params: any[] = []

  if (opts.status && opts.status !== "all") {
    where.push("j.status = ?")
    params.push(opts.status)
  } else {
    where.push("j.status <> 'Archived'")
  }
  if (opts.trigger && opts.trigger !== "all") {
    where.push("j.trigger_type = ?")
    params.push(opts.trigger)
  }
  if (opts.search) {
    where.push("(j.name LIKE ? OR j.journey_code LIKE ? OR j.description LIKE ?)")
    const like = `%${opts.search}%`
    params.push(like, like, like)
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const sortMap: Record<string, string> = {
    recent: "j.updated_at DESC",
    created: "j.created_at DESC",
    name: "j.name ASC",
    enrolled: "total_enrolled DESC",
  }
  const orderSql = sortMap[opts.sort || "recent"] || sortMap.recent

  const page = Math.max(1, opts.page || 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20))
  const offset = (page - 1) * pageSize

  const totalRows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM marketing_journeys j ${whereSql}`,
    params,
  )
  const total = Number(totalRows[0]?.c ?? 0)

  const items = await query<any[]>(
    `SELECT j.*,
        u.name AS owner_name,
        (SELECT COUNT(*) FROM marketing_journey_steps s WHERE s.journey_id = j.id) AS step_count,
        (SELECT COUNT(*) FROM marketing_journey_enrollments e WHERE e.journey_id = j.id) AS total_enrolled,
        (SELECT COUNT(*) FROM marketing_journey_enrollments e WHERE e.journey_id = j.id AND e.status IN ('Active','Waiting')) AS active_enrolled,
        (SELECT COUNT(*) FROM marketing_journey_enrollments e WHERE e.journey_id = j.id AND e.status = 'Completed') AS completed_enrolled
     FROM marketing_journeys j
     LEFT JOIN users u ON u.id = j.owner_id
     ${whereSql}
     ORDER BY ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )

  return { items: items as JourneyListItem[], total }
}

export async function createJourney(input: {
  name: string
  description?: string | null
  trigger_type: TriggerType
  trigger_config?: any
  audience_config?: any
  goal_type?: string | null
  goal_config?: any
  owner_id?: number | null
  allow_reentry?: boolean
  allow_multiple_active?: boolean
  quiet_hours_start?: number | null
  quiet_hours_end?: number | null
  created_by?: number | null
}): Promise<number> {
  const code = newJourneyCode()
  const res: any = await query(
    `INSERT INTO marketing_journeys
       (journey_code, name, description, status, trigger_type, trigger_config, audience_config,
        goal_type, goal_config, owner_id, allow_reentry, allow_multiple_active,
        quiet_hours_start, quiet_hours_end, created_by)
     VALUES (?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code,
      input.name.slice(0, 190),
      input.description ? input.description.slice(0, 500) : null,
      input.trigger_type,
      input.trigger_config ? JSON.stringify(input.trigger_config) : null,
      input.audience_config ? JSON.stringify(input.audience_config) : null,
      input.goal_type ?? null,
      input.goal_config ? JSON.stringify(input.goal_config) : null,
      input.owner_id ?? null,
      input.allow_reentry ? 1 : 0,
      input.allow_multiple_active ? 1 : 0,
      input.quiet_hours_start ?? null,
      input.quiet_hours_end ?? null,
      input.created_by ?? null,
    ],
  )
  return Number(res.insertId)
}

export async function updateJourney(
  id: number,
  patch: Partial<{
    name: string
    description: string | null
    trigger_type: TriggerType
    trigger_config: any
    audience_config: any
    goal_type: string | null
    goal_config: any
    owner_id: number | null
    allow_reentry: boolean
    allow_multiple_active: boolean
    quiet_hours_start: number | null
    quiet_hours_end: number | null
  }>,
): Promise<void> {
  const sets: string[] = []
  const params: any[] = []
  const push = (col: string, val: any) => {
    sets.push(`${col} = ?`)
    params.push(val)
  }
  if (patch.name !== undefined) push("name", patch.name.slice(0, 190))
  if (patch.description !== undefined) push("description", patch.description ? patch.description.slice(0, 500) : null)
  if (patch.trigger_type !== undefined) push("trigger_type", patch.trigger_type)
  if (patch.trigger_config !== undefined) push("trigger_config", patch.trigger_config ? JSON.stringify(patch.trigger_config) : null)
  if (patch.audience_config !== undefined) push("audience_config", patch.audience_config ? JSON.stringify(patch.audience_config) : null)
  if (patch.goal_type !== undefined) push("goal_type", patch.goal_type)
  if (patch.goal_config !== undefined) push("goal_config", patch.goal_config ? JSON.stringify(patch.goal_config) : null)
  if (patch.owner_id !== undefined) push("owner_id", patch.owner_id)
  if (patch.allow_reentry !== undefined) push("allow_reentry", patch.allow_reentry ? 1 : 0)
  if (patch.allow_multiple_active !== undefined) push("allow_multiple_active", patch.allow_multiple_active ? 1 : 0)
  if (patch.quiet_hours_start !== undefined) push("quiet_hours_start", patch.quiet_hours_start)
  if (patch.quiet_hours_end !== undefined) push("quiet_hours_end", patch.quiet_hours_end)
  if (!sets.length) return
  await query(`UPDATE marketing_journeys SET ${sets.join(", ")} WHERE id = ?`, [...params, id])
}

export async function setJourneyStatus(id: number, status: JourneyStatus): Promise<void> {
  const extra: string[] = []
  if (status === "Active") extra.push("activated_at = COALESCE(activated_at, NOW())")
  if (status === "Archived") extra.push("archived_at = NOW()")
  await query(
    `UPDATE marketing_journeys SET status = ?${extra.length ? ", " + extra.join(", ") : ""} WHERE id = ?`,
    [status, id],
  )
}

/**
 * Replace the ordered step list for a journey in one transaction-like sweep.
 * Steps are re-numbered from 1 to keep ordering dense and predictable.
 */
export async function replaceJourneySteps(
  journeyId: number,
  steps: { type: StepType; name?: string | null; config?: any; enabled?: boolean }[],
): Promise<void> {
  await query(`DELETE FROM marketing_journey_steps WHERE journey_id = ?`, [journeyId])
  let order = 1
  for (const s of steps) {
    await query(
      `INSERT INTO marketing_journey_steps (journey_id, step_order, type, name, config, enabled)
       VALUES (?,?,?,?,?,?)`,
      [
        journeyId,
        order++,
        s.type,
        s.name ? String(s.name).slice(0, 190) : null,
        s.config ? JSON.stringify(s.config) : null,
        s.enabled === false ? 0 : 1,
      ],
    )
  }
}

export async function duplicateJourney(id: number, createdBy: number | null): Promise<number | null> {
  const src = await getJourney(id)
  if (!src) return null
  const newId = await createJourney({
    name: `${src.name} (Copy)`,
    description: src.description,
    trigger_type: src.trigger_type,
    trigger_config: parseJson(src.trigger_config, null),
    audience_config: parseJson(src.audience_config, null),
    goal_type: src.goal_type,
    goal_config: parseJson(src.goal_config, null),
    owner_id: src.owner_id,
    allow_reentry: !!src.allow_reentry,
    allow_multiple_active: !!src.allow_multiple_active,
    quiet_hours_start: src.quiet_hours_start,
    quiet_hours_end: src.quiet_hours_end,
    created_by: createdBy,
  })
  const steps = await getJourneySteps(id)
  await replaceJourneySteps(
    newId,
    steps.map((s) => ({
      type: s.type,
      name: s.name,
      config: parseJson(s.config, null),
      enabled: !!s.enabled,
    })),
  )
  return newId
}

// ---------------------------------------------------------------------------
// Enrollments listing + analytics
// ---------------------------------------------------------------------------

export async function listEnrollments(
  journeyId: number,
  opts: { status?: string; search?: string; page?: number; pageSize?: number },
): Promise<{ items: any[]; total: number }> {
  const where: string[] = ["e.journey_id = ?"]
  const params: any[] = [journeyId]
  if (opts.status && opts.status !== "all") {
    where.push("e.status = ?")
    params.push(opts.status)
  }
  if (opts.search) {
    where.push("(c.full_name LIKE ? OR c.email LIKE ? OR c.contact_code LIKE ?)")
    const like = `%${opts.search}%`
    params.push(like, like, like)
  }
  const whereSql = `WHERE ${where.join(" AND ")}`
  const page = Math.max(1, opts.page || 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 25))
  const offset = (page - 1) * pageSize

  const totalRows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM marketing_journey_enrollments e
     LEFT JOIN marketing_contacts c ON c.id = e.contact_id ${whereSql}`,
    params,
  )
  const total = Number(totalRows[0]?.c ?? 0)

  const items = await query<any[]>(
    `SELECT e.*, c.full_name AS contact_name, c.email AS contact_email, c.contact_code
     FROM marketing_journey_enrollments e
     LEFT JOIN marketing_contacts c ON c.id = e.contact_id
     ${whereSql}
     ORDER BY e.updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )
  return { items, total }
}

export type JourneyAnalytics = {
  totals: Record<string, number>
  totalEnrolled: number
  completionRate: number
  goalRate: number
  stepBreakdown: { type: string; count: number; completed: number; failed: number }[]
  recentEvents: any[]
}

export async function getJourneyAnalytics(journeyId: number): Promise<JourneyAnalytics> {
  const statusRows = await query<any[]>(
    `SELECT status, COUNT(*) AS c FROM marketing_journey_enrollments WHERE journey_id = ? GROUP BY status`,
    [journeyId],
  )
  const totals: Record<string, number> = {}
  let totalEnrolled = 0
  let completed = 0
  let goalReachedTotal = 0
  for (const r of statusRows) {
    totals[r.status] = Number(r.c)
    totalEnrolled += Number(r.c)
    if (r.status === "Completed") completed += Number(r.c)
  }
  const goalRows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM marketing_journey_enrollments WHERE journey_id = ? AND goal_reached = 1`,
    [journeyId],
  )
  goalReachedTotal = Number(goalRows[0]?.c ?? 0)

  const stepRows = await query<any[]>(
    `SELECT type,
        COUNT(*) AS count,
        SUM(status = 'Completed') AS completed,
        SUM(status = 'Failed') AS failed
     FROM marketing_journey_step_runs
     WHERE journey_id = ?
     GROUP BY type`,
    [journeyId],
  )

  const recentEvents = await query<any[]>(
    `SELECT ev.*, c.full_name AS contact_name
     FROM marketing_journey_events ev
     LEFT JOIN marketing_contacts c ON c.id = ev.contact_id
     WHERE ev.journey_id = ?
     ORDER BY ev.created_at DESC
     LIMIT 40`,
    [journeyId],
  )

  return {
    totals,
    totalEnrolled,
    completionRate: totalEnrolled ? Math.round((completed / totalEnrolled) * 100) : 0,
    goalRate: totalEnrolled ? Math.round((goalReachedTotal / totalEnrolled) * 100) : 0,
    stepBreakdown: stepRows.map((r) => ({
      type: r.type,
      count: Number(r.count),
      completed: Number(r.completed || 0),
      failed: Number(r.failed || 0),
    })),
    recentEvents,
  }
}

// ---------------------------------------------------------------------------
// Dashboard summary (across all journeys)
// ---------------------------------------------------------------------------

export async function getJourneysSummary(): Promise<{
  activeJourneys: number
  totalJourneys: number
  contactsEnrolled: number
  activeEnrollments: number
  completedEnrollments: number
  avgCompletionRate: number
}> {
  const jRows = await query<any[]>(
    `SELECT
       SUM(status = 'Active') AS active,
       SUM(status <> 'Archived') AS total
     FROM marketing_journeys`,
  )
  const eRows = await query<any[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(status IN ('Active','Waiting')) AS active,
       SUM(status = 'Completed') AS completed
     FROM marketing_journey_enrollments`,
  )
  const total = Number(eRows[0]?.total ?? 0)
  const completed = Number(eRows[0]?.completed ?? 0)
  return {
    activeJourneys: Number(jRows[0]?.active ?? 0),
    totalJourneys: Number(jRows[0]?.total ?? 0),
    contactsEnrolled: total,
    activeEnrollments: Number(eRows[0]?.active ?? 0),
    completedEnrollments: completed,
    avgCompletionRate: total ? Math.round((completed / total) * 100) : 0,
  }
}
