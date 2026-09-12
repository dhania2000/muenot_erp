import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  type CycleType,
  type PatternStep,
  validatePattern,
  describeCycle,
} from "@/lib/rotation-ui"

// ---------------------------------------------------------------------------
// Shift Rotations — the recurring-schedule layer that FEEDS the central shift
// resolver. Responsibility boundaries (never crossed here):
//   • Shift Master (hr_shifts)            → shift rules / policy (read only)
//   • Employees (hr_employees)            → who exists / department (read only)
//   • Shift Assignments                   → explicit overrides that BEAT a
//                                           rotation (owned elsewhere)
//   • Rotations (this module)             → cyclic pattern + memberships that,
//                                           absent an explicit assignment,
//                                           resolve an employee's daily shift
//
// This service owns: schema safety, immutable ERP ids (ROT/RTV/RSQ/RTE via the
// shared sequence — no second generator), effective-dated pattern VERSIONS so a
// running rotation is never rewritten, membership with start/end windows and
// department bulk assignment, membership conflict detection, per-rotation audit,
// and list/detail/preview helpers. Cycle resolution is the single pure engine
// in lib/rotation-ui.ts, reused by the attendance resolver — never duplicated.
// ---------------------------------------------------------------------------

export const ROTATION_ID_PREFIX = "ROT"
export const VERSION_ID_PREFIX = "RTV"
export const SEQUENCE_ID_PREFIX = "RSQ"
export const MEMBER_ID_PREFIX = "RTE"

export type Actor = { userId: number; name: string; email: string; role: "admin" | "employee" }

const INACTIVE_STATUSES = new Set([
  "terminated", "resigned", "exited", "inactive", "left", "archived", "offboarded", "ex-employee",
])

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Schema safety — additive & idempotent (MySQL lacks ADD COLUMN IF NOT EXISTS).
// ---------------------------------------------------------------------------

let schemaEnsured: Promise<void> | null = null
export function ensureShiftRotationSchema(): Promise<void> {
  if (!schemaEnsured) schemaEnsured = doEnsureSchema()
  return schemaEnsured
}

async function run(sql: string, args: any[] = []) {
  try {
    await query(sql, args)
  } catch {
    // Column/index/table already exists, or an optional seed — ignore.
  }
}

async function doEnsureSchema() {
  // Base tables (created by the original workflows migration; recreate defensively).
  await run(`CREATE TABLE IF NOT EXISTS hr_shift_rotations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rotation_id VARCHAR(50) NOT NULL,
    rotation_name VARCHAR(120) NOT NULL, description VARCHAR(500),
    cycle_type ENUM('Days','Weeks','Months') NOT NULL DEFAULT 'Weeks',
    cycle_length INT UNSIGNED NOT NULL DEFAULT 1,
    status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
    start_date DATE NOT NULL, created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(id), UNIQUE KEY uq_rotation(rotation_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await run(`CREATE TABLE IF NOT EXISTS hr_shift_rotation_sequences (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, sequence_id VARCHAR(50) NOT NULL,
    rotation_id BIGINT UNSIGNED NOT NULL, sequence_no INT UNSIGNED NOT NULL,
    shift_id BIGINT UNSIGNED NOT NULL, duration_days INT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY(id), UNIQUE KEY uq_rotation_sequence(sequence_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await run(`CREATE TABLE IF NOT EXISTS hr_shift_rotation_employees (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, record_id VARCHAR(50) NOT NULL,
    rotation_id BIGINT UNSIGNED NOT NULL, employee_id BIGINT UNSIGNED NOT NULL,
    start_date DATE NOT NULL, current_sequence INT UNSIGNED NOT NULL DEFAULT 1,
    last_run DATE NULL, next_run DATE NULL,
    status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
    PRIMARY KEY(id), UNIQUE KEY uq_rotation_employee(record_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Header upgrades.
  await run("ALTER TABLE hr_shift_rotations ADD COLUMN rotation_code VARCHAR(40) DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotations ADD COLUMN effective_from DATE DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotations ADD COLUMN effective_until DATE DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotations ADD COLUMN time_zone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'")
  await run("ALTER TABLE hr_shift_rotations ADD COLUMN current_version_no INT UNSIGNED NOT NULL DEFAULT 1")
  await run("ALTER TABLE hr_shift_rotations ADD COLUMN created_by_name VARCHAR(150) DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotations ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL")
  // Legacy rows: seed effective_from from start_date so windowing works.
  await run("UPDATE hr_shift_rotations SET effective_from = start_date WHERE effective_from IS NULL")

  // Version table.
  await run(`CREATE TABLE IF NOT EXISTS hr_shift_rotation_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, version_id VARCHAR(50) NOT NULL,
    rotation_id BIGINT UNSIGNED NOT NULL, version_no INT UNSIGNED NOT NULL,
    effective_from DATE NOT NULL,
    cycle_type ENUM('Days','Weeks','Months') NOT NULL DEFAULT 'Weeks',
    cycle_length INT UNSIGNED NOT NULL DEFAULT 1, notes VARCHAR(500) DEFAULT NULL,
    created_by BIGINT UNSIGNED DEFAULT NULL, created_by_name VARCHAR(150) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uq_rotation_version (version_id),
    UNIQUE KEY uq_rotation_version_no (rotation_id, version_no),
    KEY idx_rotation_version_eff (rotation_id, effective_from)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // Sequence upgrades.
  await run("ALTER TABLE hr_shift_rotation_sequences ADD COLUMN version_id BIGINT UNSIGNED DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotation_sequences ADD COLUMN unit_span INT UNSIGNED NOT NULL DEFAULT 1")
  await run("ALTER TABLE hr_shift_rotation_sequences ADD COLUMN is_weekly_off TINYINT(1) NOT NULL DEFAULT 0")
  await run("ALTER TABLE hr_shift_rotation_sequences ADD COLUMN label VARCHAR(120) DEFAULT NULL")
  await run("CREATE INDEX idx_rotation_seq_version ON hr_shift_rotation_sequences (version_id, sequence_no)")

  // Membership upgrades.
  await run("ALTER TABLE hr_shift_rotation_employees ADD COLUMN end_date DATE DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotation_employees ADD COLUMN added_by BIGINT UNSIGNED DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotation_employees ADD COLUMN added_by_name VARCHAR(150) DEFAULT NULL")
  await run("ALTER TABLE hr_shift_rotation_employees ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP")
  await run("ALTER TABLE hr_shift_rotation_employees ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL")
  await run("CREATE INDEX idx_rotation_emp_window ON hr_shift_rotation_employees (employee_id, start_date, end_date)")

  // Audit trail.
  await run(`CREATE TABLE IF NOT EXISTS hr_shift_rotation_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rotation_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(60) NOT NULL, summary VARCHAR(255) NOT NULL,
    changes JSON DEFAULT NULL, reason VARCHAR(500) DEFAULT NULL,
    actor_id BIGINT UNSIGNED DEFAULT NULL, actor_name VARCHAR(150) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY idx_rotation_event_ref (rotation_id, created_at),
    KEY idx_rotation_event_type (event_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // Backfill: give legacy rotations (sequences without a version) a v1 wrapper so
  // the version-aware resolver and UI treat them uniformly.
  await run(`INSERT INTO hr_shift_rotation_versions (version_id, rotation_id, version_no, effective_from, cycle_type, cycle_length, created_by_name)
    SELECT CONCAT('RTV-LEG-', r.id), r.id, 1, COALESCE(r.effective_from, r.start_date), r.cycle_type, r.cycle_length, 'System (legacy)'
    FROM hr_shift_rotations r
    WHERE NOT EXISTS (SELECT 1 FROM hr_shift_rotation_versions v WHERE v.rotation_id = r.id)
      AND EXISTS (SELECT 1 FROM hr_shift_rotation_sequences s WHERE s.rotation_id = r.id)`)
  await run(`UPDATE hr_shift_rotation_sequences s
    JOIN hr_shift_rotation_versions v ON v.rotation_id = s.rotation_id AND v.version_no = 1
    SET s.version_id = v.id, s.unit_span = GREATEST(1, s.duration_days)
    WHERE s.version_id IS NULL`)

  // RBAC features.
  await run(`INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
    SELECT id,'Manage Shift Rotations','hr.manage_shift_rotations','Create, edit, version and end shift rotations',19 FROM modules WHERE slug='hr'`)
  await run(`INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
    SELECT id,'Override Shift Rotation Conflicts','hr.override_shift_rotations','Override overlapping rotation membership conflicts',20 FROM modules WHERE slug='hr'`)
}

// ---------------------------------------------------------------------------
// Read-only masters
// ---------------------------------------------------------------------------

export type ShiftOption = {
  id: number
  shift_id: string | null
  shift_code: string | null
  shift_name: string
  start_time: string | null
  end_time: string | null
  is_overnight: number | boolean
  working_hours: number | null
  status: string | null
}

export async function listActiveShifts(): Promise<ShiftOption[]> {
  return query<ShiftOption[]>(
    `SELECT id, shift_id, shift_code, shift_name, start_time, end_time, is_overnight, working_hours, status
     FROM hr_shifts WHERE status = 'Active' OR status IS NULL ORDER BY shift_name`,
  )
}

export type EmployeeOption = {
  id: number
  employee_id: string
  employee_name: string
  department: string | null
  designation: string | null
  employment_status: string | null
  exit_date: string | null
}

export async function listAssignableEmployees(): Promise<EmployeeOption[]> {
  return query<EmployeeOption[]>(
    `SELECT id, employee_id, employee_name, department, designation, employment_status, exit_date
     FROM hr_employees WHERE archived_at IS NULL ORDER BY employee_name LIMIT 5000`,
  )
}

export async function listDepartments(): Promise<string[]> {
  const rows = await query<{ department: string }[]>(
    `SELECT DISTINCT department FROM hr_employees WHERE archived_at IS NULL AND department IS NOT NULL AND department <> '' ORDER BY department`,
  )
  return rows.map((r) => r.department)
}

function employeeEligible(e: { employment_status: string | null; exit_date: string | null }, onDate: string): boolean {
  const status = (e.employment_status || "").trim().toLowerCase()
  if (INACTIVE_STATUSES.has(status)) return false
  if (e.exit_date && String(e.exit_date).slice(0, 10) < onDate) return false
  return true
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export const nextRotationId = () => nextRecordId(ROTATION_ID_PREFIX, { digits: 4 })
export const nextVersionId = () => nextRecordId(VERSION_ID_PREFIX, { digits: 4 })
export const nextSequenceId = () => nextRecordId(SEQUENCE_ID_PREFIX, { digits: 5 })
export const nextMemberId = () => nextRecordId(MEMBER_ID_PREFIX, { digits: 5 })

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function logRotationEvent(opts: {
  rotationId: string
  eventType: string
  summary: string
  changes?: unknown
  reason?: string | null
  actor: Actor
}): Promise<void> {
  try {
    await query(
      `INSERT INTO hr_shift_rotation_events (rotation_id, event_type, summary, changes, reason, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?)`,
      [
        opts.rotationId,
        opts.eventType,
        opts.summary.slice(0, 255),
        opts.changes ? JSON.stringify(opts.changes) : null,
        opts.reason ? String(opts.reason).slice(0, 500) : null,
        opts.actor.userId,
        opts.actor.name,
      ],
    )
  } catch (error) {
    console.log("[v0] logRotationEvent failed", (error as Error).message)
  }
}

export async function getRotationEvents(rotationId: string): Promise<any[]> {
  return query<any[]>(
    `SELECT event_type, summary, changes, reason, actor_name, created_at
     FROM hr_shift_rotation_events WHERE rotation_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
    [rotationId],
  )
}

// ---------------------------------------------------------------------------
// Create / version / update
// ---------------------------------------------------------------------------

export type CreateRotationInput = {
  rotation_name: string
  description: string | null
  cycle_type: CycleType
  cycle_length: number
  effective_from: string
  effective_until: string | null
  time_zone: string
  steps: PatternStep[]
}

export type ValidationResult = { ok: boolean; errors: string[] }

export function validateRotationInput(input: CreateRotationInput): ValidationResult {
  const errors: string[] = []
  if (!input.rotation_name || !input.rotation_name.trim()) errors.push("Rotation name is required.")
  if (!input.effective_from) errors.push("Effective From is required.")
  if (input.effective_until && input.effective_until < input.effective_from) {
    errors.push("Effective Until cannot be before Effective From.")
  }
  const patternError = validatePattern(input.cycle_type, input.cycle_length, input.steps)
  if (patternError) errors.push(patternError)
  return { ok: errors.length === 0, errors }
}

/** Create a rotation with its initial (v1) pattern version, transactionally. */
export async function createRotation(
  input: CreateRotationInput,
  actor: Actor,
): Promise<{ ok: true; rotationId: string } | { ok: false; validation: ValidationResult }> {
  await ensureShiftRotationSchema()
  const validation = validateRotationInput(input)
  if (!validation.ok) return { ok: false, validation }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const rotationId = await nextRotationId()
    const versionId = await nextVersionId()

    const [res]: any = await conn.query(
      `INSERT INTO hr_shift_rotations
        (rotation_id, rotation_name, description, cycle_type, cycle_length, status, start_date,
         effective_from, effective_until, time_zone, current_version_no, created_by, created_by_name, created_at)
       VALUES (?,?,?,?,?, 'Active', ?, ?,?,?, 1, ?,?, CURRENT_TIMESTAMP)`,
      [
        rotationId,
        input.rotation_name.trim(),
        input.description?.trim() || null,
        input.cycle_type,
        input.cycle_length,
        input.effective_from,
        input.effective_from,
        input.effective_until,
        input.time_zone || "Asia/Kolkata",
        actor.userId,
        actor.name,
      ],
    )
    const rotationPk = Number(res.insertId)

    const [vres]: any = await conn.query(
      `INSERT INTO hr_shift_rotation_versions
        (version_id, rotation_id, version_no, effective_from, cycle_type, cycle_length, notes, created_by, created_by_name)
       VALUES (?,?, 1, ?,?,?,?,?,?)`,
      [versionId, rotationPk, input.effective_from, input.cycle_type, input.cycle_length, "Initial version", actor.userId, actor.name],
    )
    const versionPk = Number(vres.insertId)

    await insertSteps(conn, rotationPk, versionPk, input.steps)

    await conn.commit()
    await logRotationEvent({
      rotationId,
      eventType: "created",
      summary: `Rotation created — ${describeCycle(input.cycle_type, input.cycle_length, input.steps)}`,
      changes: { cycle_type: input.cycle_type, cycle_length: input.cycle_length, steps: input.steps.length },
      actor,
    })
    return { ok: true, rotationId }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function insertSteps(conn: any, rotationPk: number, versionPk: number, steps: PatternStep[]) {
  let seqNo = 1
  for (const step of steps) {
    const sequenceId = await nextSequenceId()
    await conn.query(
      `INSERT INTO hr_shift_rotation_sequences
        (sequence_id, rotation_id, version_id, sequence_no, shift_id, duration_days, unit_span, is_weekly_off, label)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        sequenceId,
        rotationPk,
        versionPk,
        seqNo++,
        step.is_weekly_off ? 0 : step.shift_id,
        Math.max(1, step.unit_span),
        Math.max(1, step.unit_span),
        step.is_weekly_off ? 1 : 0,
        step.label?.slice(0, 120) || null,
      ],
    )
  }
}

/**
 * Add a new effective-dated pattern version. Editing a running rotation NEVER
 * rewrites history (§39/§40/§93) — the new pattern applies from effective_from
 * onward and prior versions stay intact for historical resolution.
 */
export async function addRotationVersion(
  rotationId: string,
  input: { effective_from: string; cycle_type: CycleType; cycle_length: number; steps: PatternStep[]; notes: string | null },
  actor: Actor,
): Promise<{ ok: true; versionNo: number } | { ok: false; errors: string[] }> {
  await ensureShiftRotationSchema()
  const rot = await query<any[]>(`SELECT id, effective_from FROM hr_shift_rotations WHERE rotation_id = ? LIMIT 1`, [rotationId])
  if (!rot[0]) return { ok: false, errors: ["Rotation not found."] }

  const errors: string[] = []
  if (!input.effective_from) errors.push("A version effective date is required.")
  // A new version must start no earlier than today so it cannot rewrite the past.
  if (input.effective_from && input.effective_from < todayStr()) {
    errors.push("A new version must take effect today or later so history is preserved.")
  }
  const patternError = validatePattern(input.cycle_type, input.cycle_length, input.steps)
  if (patternError) errors.push(patternError)

  // Effective date must be after the latest existing version.
  const latest = await query<any[]>(
    `SELECT version_no, effective_from FROM hr_shift_rotation_versions WHERE rotation_id = ? ORDER BY version_no DESC LIMIT 1`,
    [rot[0].id],
  )
  if (latest[0] && input.effective_from <= String(latest[0].effective_from).slice(0, 10)) {
    errors.push(`Version effective date must be after the current version (${String(latest[0].effective_from).slice(0, 10)}).`)
  }
  if (errors.length) return { ok: false, errors }

  const nextNo = Number(latest[0]?.version_no || 0) + 1
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const versionId = await nextVersionId()
    const [vres]: any = await conn.query(
      `INSERT INTO hr_shift_rotation_versions
        (version_id, rotation_id, version_no, effective_from, cycle_type, cycle_length, notes, created_by, created_by_name)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [versionId, rot[0].id, nextNo, input.effective_from, input.cycle_type, input.cycle_length, input.notes?.slice(0, 500) || null, actor.userId, actor.name],
    )
    await insertSteps(conn, rot[0].id, Number(vres.insertId), input.steps)
    await conn.query(
      `UPDATE hr_shift_rotations SET current_version_no = ?, cycle_type = ?, cycle_length = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextNo, input.cycle_type, input.cycle_length, rot[0].id],
    )
    await conn.commit()
    await logRotationEvent({
      rotationId,
      eventType: "version_added",
      summary: `New pattern version v${nextNo} effective ${input.effective_from}`,
      changes: { version_no: nextNo, effective_from: input.effective_from, steps: input.steps.length },
      actor,
    })
    return { ok: true, versionNo: nextNo }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export async function updateRotationHeader(
  rotationId: string,
  patch: { rotation_name?: string; description?: string | null; effective_until?: string | null; time_zone?: string },
  actor: Actor,
): Promise<{ ok: boolean; errors?: string[] }> {
  await ensureShiftRotationSchema()
  const rot = await query<any[]>(`SELECT id, effective_from FROM hr_shift_rotations WHERE rotation_id = ? LIMIT 1`, [rotationId])
  if (!rot[0]) return { ok: false, errors: ["Rotation not found."] }
  if (patch.effective_until && patch.effective_until < String(rot[0].effective_from).slice(0, 10)) {
    return { ok: false, errors: ["Effective Until cannot be before the rotation's effective from."] }
  }
  const fields: string[] = []
  const args: any[] = []
  if (patch.rotation_name !== undefined) { fields.push("rotation_name = ?"); args.push(patch.rotation_name.trim()) }
  if (patch.description !== undefined) { fields.push("description = ?"); args.push(patch.description?.trim() || null) }
  if (patch.effective_until !== undefined) { fields.push("effective_until = ?"); args.push(patch.effective_until || null) }
  if (patch.time_zone !== undefined) { fields.push("time_zone = ?"); args.push(patch.time_zone) }
  if (!fields.length) return { ok: true }
  fields.push("updated_at = CURRENT_TIMESTAMP")
  await query(`UPDATE hr_shift_rotations SET ${fields.join(", ")} WHERE id = ?`, [...args, rot[0].id])
  await logRotationEvent({ rotationId, eventType: "updated", summary: "Rotation details updated", changes: patch, actor })
  return { ok: true }
}

export async function setRotationStatus(rotationId: string, status: "Active" | "Inactive", actor: Actor): Promise<boolean> {
  await ensureShiftRotationSchema()
  const res: any = await query(`UPDATE hr_shift_rotations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE rotation_id = ?`, [status, rotationId])
  await logRotationEvent({ rotationId, eventType: status === "Active" ? "activated" : "deactivated", summary: `Rotation ${status === "Active" ? "activated" : "deactivated"}`, actor })
  return Number(res?.affectedRows || 0) > 0
}

// ---------------------------------------------------------------------------
// Membership (single + department bulk) with start/end windows
// ---------------------------------------------------------------------------

export type MembershipConflict = {
  employeeId: number
  employeeName: string
  reason: string
  otherRotationId: string
  otherRotationName: string
}

/** Employees whose active membership window overlaps [from,to) in ANOTHER rotation. */
export async function detectMembershipConflicts(
  rotationPk: number,
  employeeIds: number[],
  from: string,
  to: string | null,
): Promise<MembershipConflict[]> {
  if (!employeeIds.length) return []
  const placeholders = employeeIds.map(() => "?").join(",")
  const rows = await query<any[]>(
    `SELECT re.employee_id, e.employee_name, r.rotation_id AS other_code, r.rotation_name AS other_name,
            re.start_date, re.end_date
     FROM hr_shift_rotation_employees re
     JOIN hr_shift_rotations r ON r.id = re.rotation_id
     JOIN hr_employees e ON e.id = re.employee_id
     WHERE re.employee_id IN (${placeholders}) AND re.status = 'Active' AND re.rotation_id <> ?`,
    [...employeeIds, rotationPk],
  )
  const conflicts: MembershipConflict[] = []
  for (const r of rows) {
    const oFrom = String(r.start_date).slice(0, 10)
    const oTo = r.end_date ? String(r.end_date).slice(0, 10) : null
    if (rangesOverlap(from, to, oFrom, oTo)) {
      conflicts.push({
        employeeId: Number(r.employee_id),
        employeeName: r.employee_name,
        reason: `Already in rotation ${r.other_code} for an overlapping period`,
        otherRotationId: r.other_code,
        otherRotationName: r.other_name,
      })
    }
  }
  return conflicts
}

export type AddMembersInput = {
  employeeIds: number[]
  start_date: string
  end_date: string | null
}

export type AddMembersResult = {
  ok: boolean
  added: number
  skipped: { employeeId: number; employeeName: string; reason: string }[]
  errors: string[]
}

export async function addMembers(
  rotationId: string,
  input: AddMembersInput,
  actor: Actor,
  canOverride: boolean,
): Promise<AddMembersResult> {
  await ensureShiftRotationSchema()
  const rot = await query<any[]>(`SELECT id, rotation_name, effective_from, effective_until, status FROM hr_shift_rotations WHERE rotation_id = ? LIMIT 1`, [rotationId])
  if (!rot[0]) return { ok: false, added: 0, skipped: [], errors: ["Rotation not found."] }

  const errors: string[] = []
  if (!input.start_date) errors.push("A membership start date is required.")
  if (input.end_date && input.end_date < input.start_date) errors.push("Membership end date cannot be before the start date.")
  const rotFrom = String(rot[0].effective_from).slice(0, 10)
  if (input.start_date && input.start_date < rotFrom) errors.push(`Membership cannot start before the rotation's effective date (${rotFrom}).`)
  if (rot[0].effective_until && input.start_date > String(rot[0].effective_until).slice(0, 10)) {
    errors.push("Membership start is after the rotation's effective-until date.")
  }
  if (errors.length) return { ok: false, added: 0, skipped: [], errors }

  const ids = Array.from(new Set(input.employeeIds.map(Number).filter(Boolean)))
  if (!ids.length) return { ok: false, added: 0, skipped: [], errors: ["Select at least one employee."] }

  // Read employee master once for eligibility + naming.
  const placeholders = ids.map(() => "?").join(",")
  const emps = await query<any[]>(
    `SELECT id, employee_name, employment_status, exit_date FROM hr_employees WHERE id IN (${placeholders})`,
    ids,
  )
  const empById = new Map(emps.map((e) => [Number(e.id), e]))

  const skipped: AddMembersResult["skipped"] = []
  const eligibleIds: number[] = []
  for (const id of ids) {
    const e = empById.get(id)
    if (!e) { skipped.push({ employeeId: id, employeeName: `#${id}`, reason: "Employee not found" }); continue }
    if (!employeeEligible(e, input.start_date) && !canOverride) {
      skipped.push({ employeeId: id, employeeName: e.employee_name, reason: `Not eligible (${e.employment_status || "inactive"})` })
      continue
    }
    eligibleIds.push(id)
  }

  // Cross-rotation conflicts (advisory unless override).
  const conflicts = await detectMembershipConflicts(rot[0].id, eligibleIds, input.start_date, input.end_date)
  const conflictSet = new Set(conflicts.map((c) => c.employeeId))
  const toAdd: number[] = []
  for (const id of eligibleIds) {
    if (conflictSet.has(id) && !canOverride) {
      const c = conflicts.find((x) => x.employeeId === id)!
      skipped.push({ employeeId: id, employeeName: c.employeeName, reason: c.reason })
      continue
    }
    toAdd.push(id)
  }

  let added = 0
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const id of toAdd) {
      const e = empById.get(id)!
      // Skip a duplicate identical active membership in THIS rotation.
      const [dupe]: any = await conn.query(
        `SELECT id FROM hr_shift_rotation_employees WHERE rotation_id = ? AND employee_id = ? AND status = 'Active' AND start_date = ? LIMIT 1`,
        [rot[0].id, id, input.start_date],
      )
      if ((dupe as any[]).length) {
        skipped.push({ employeeId: id, employeeName: e.employee_name, reason: "Already a member from this date" })
        continue
      }
      const memberId = await nextMemberId()
      await conn.query(
        `INSERT INTO hr_shift_rotation_employees
          (record_id, rotation_id, employee_id, start_date, end_date, current_sequence, status, added_by, added_by_name, created_at)
         VALUES (?,?,?,?,?, 1, 'Active', ?,?, CURRENT_TIMESTAMP)`,
        [memberId, rot[0].id, id, input.start_date, input.end_date, actor.userId, actor.name],
      )
      added++
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  if (added > 0) {
    await logRotationEvent({
      rotationId,
      eventType: "members_added",
      summary: `${added} employee(s) assigned to the rotation`,
      changes: { added, from: input.start_date, to: input.end_date, skipped: skipped.length },
      actor,
    })
  }
  return { ok: true, added, skipped, errors: [] }
}

/** Resolve a department to its currently eligible employee ids (for bulk assign). */
export async function employeesInDepartment(department: string, onDate: string): Promise<EmployeeOption[]> {
  const rows = await query<EmployeeOption[]>(
    `SELECT id, employee_id, employee_name, department, designation, employment_status, exit_date
     FROM hr_employees WHERE archived_at IS NULL AND department = ? ORDER BY employee_name`,
    [department],
  )
  return rows.filter((e) => employeeEligible(e, onDate))
}

export async function endMembership(recordId: string, endDate: string, actor: Actor): Promise<{ ok: boolean; errors?: string[] }> {
  await ensureShiftRotationSchema()
  const row = await query<any[]>(
    `SELECT re.id, re.start_date, r.rotation_id AS code FROM hr_shift_rotation_employees re
     JOIN hr_shift_rotations r ON r.id = re.rotation_id WHERE re.record_id = ? LIMIT 1`,
    [recordId],
  )
  if (!row[0]) return { ok: false, errors: ["Membership not found."] }
  if (endDate < String(row[0].start_date).slice(0, 10)) return { ok: false, errors: ["End date cannot be before the membership start date."] }
  await query(`UPDATE hr_shift_rotation_employees SET end_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [endDate, row[0].id])
  await logRotationEvent({ rotationId: row[0].code, eventType: "member_ended", summary: `Membership ${recordId} ended ${endDate}`, changes: { recordId, endDate }, actor })
  return { ok: true }
}

export async function setMembershipStatus(recordId: string, status: "Active" | "Inactive", actor: Actor): Promise<boolean> {
  await ensureShiftRotationSchema()
  const row = await query<any[]>(
    `SELECT re.id, r.rotation_id AS code FROM hr_shift_rotation_employees re
     JOIN hr_shift_rotations r ON r.id = re.rotation_id WHERE re.record_id = ? LIMIT 1`,
    [recordId],
  )
  if (!row[0]) return false
  await query(`UPDATE hr_shift_rotation_employees SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, row[0].id])
  await logRotationEvent({ rotationId: row[0].code, eventType: "member_status", summary: `Membership ${recordId} set ${status}`, actor })
  return true
}

// ---------------------------------------------------------------------------
// List / detail / preview
// ---------------------------------------------------------------------------

export async function listRotations(opts: { q?: string; status?: string; cycleType?: string; state?: string }): Promise<any[]> {
  await ensureShiftRotationSchema()
  const where: string[] = []
  const args: any[] = []
  const today = todayStr()
  if (opts.q) {
    const like = `%${opts.q}%`
    where.push("(r.rotation_id LIKE ? OR r.rotation_name LIKE ? OR r.rotation_code LIKE ?)")
    args.push(like, like, like)
  }
  if (opts.status && opts.status !== "all") { where.push("r.status = ?"); args.push(opts.status) }
  if (opts.cycleType && opts.cycleType !== "all") { where.push("r.cycle_type = ?"); args.push(opts.cycleType) }
  if (opts.state === "running") {
    where.push("r.status = 'Active' AND r.effective_from <= ? AND (r.effective_until IS NULL OR r.effective_until >= ?)")
    args.push(today, today)
  } else if (opts.state === "scheduled") {
    where.push("r.status = 'Active' AND r.effective_from > ?"); args.push(today)
  } else if (opts.state === "ended") {
    where.push("(r.status = 'Inactive' OR (r.effective_until IS NOT NULL AND r.effective_until < ?))"); args.push(today)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  return query<any[]>(
    `SELECT r.id, r.rotation_id, r.rotation_name, r.rotation_code, r.description, r.cycle_type, r.cycle_length,
            r.status, r.effective_from, r.effective_until, r.time_zone, r.current_version_no, r.created_by_name, r.created_at,
            (SELECT COUNT(*) FROM hr_shift_rotation_employees re WHERE re.rotation_id = r.id AND re.status = 'Active'
               AND re.start_date <= ? AND (re.end_date IS NULL OR re.end_date >= ?)) AS active_members,
            (SELECT COUNT(*) FROM hr_shift_rotation_employees re WHERE re.rotation_id = r.id) AS total_members
     FROM hr_shift_rotations r ${whereSql}
     ORDER BY (r.status = 'Active') DESC, r.effective_from DESC, r.id DESC`,
    [today, today, ...args],
  )
}

export async function getRotationSummary(): Promise<{ running: number; scheduled: number; ended: number; total: number; assigned: number }> {
  await ensureShiftRotationSchema()
  const today = todayStr()
  const rows = await query<any[]>(
    `SELECT
       SUM(status = 'Active' AND effective_from <= ? AND (effective_until IS NULL OR effective_until >= ?)) AS running,
       SUM(status = 'Active' AND effective_from > ?) AS scheduled,
       SUM(status = 'Inactive' OR (effective_until IS NOT NULL AND effective_until < ?)) AS ended,
       COUNT(*) AS total
     FROM hr_shift_rotations`,
    [today, today, today, today],
  )
  const assignedRows = await query<any[]>(
    `SELECT COUNT(DISTINCT employee_id) AS assigned FROM hr_shift_rotation_employees
     WHERE status = 'Active' AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
    [today, today],
  )
  return {
    running: Number(rows[0]?.running || 0),
    scheduled: Number(rows[0]?.scheduled || 0),
    ended: Number(rows[0]?.ended || 0),
    total: Number(rows[0]?.total || 0),
    assigned: Number(assignedRows[0]?.assigned || 0),
  }
}

export async function getRotationDetail(rotationId: string): Promise<any | null> {
  await ensureShiftRotationSchema()
  const rot = await query<any[]>(`SELECT * FROM hr_shift_rotations WHERE rotation_id = ? LIMIT 1`, [rotationId])
  if (!rot[0]) return null
  const rotationPk = Number(rot[0].id)

  const versions = await query<any[]>(
    `SELECT id, version_id, version_no, effective_from, cycle_type, cycle_length, notes, created_by_name, created_at
     FROM hr_shift_rotation_versions WHERE rotation_id = ? ORDER BY version_no DESC`,
    [rotationPk],
  )
  const sequences = await query<any[]>(
    `SELECT s.id, s.sequence_id, s.version_id, s.sequence_no, s.shift_id, s.unit_span, s.duration_days, s.is_weekly_off, s.label,
            sh.shift_name, sh.shift_code, sh.start_time, sh.end_time, sh.is_overnight
     FROM hr_shift_rotation_sequences s
     LEFT JOIN hr_shifts sh ON sh.id = s.shift_id
     WHERE s.rotation_id = ? ORDER BY s.version_id DESC, s.sequence_no ASC`,
    [rotationPk],
  )
  const members = await query<any[]>(
    `SELECT re.record_id, re.employee_id, re.start_date, re.end_date, re.status, re.added_by_name, re.created_at,
            e.employee_name, e.employee_id AS employee_code, e.department, e.designation, e.employment_status
     FROM hr_shift_rotation_employees re
     LEFT JOIN hr_employees e ON e.id = re.employee_id
     WHERE re.rotation_id = ? ORDER BY (re.status = 'Active') DESC, re.start_date DESC`,
    [rotationPk],
  )
  const events = await getRotationEvents(rotationId)
  return { rotation: rot[0], versions, sequences, members, events }
}

/** Steps for the version effective on `onDate` (falls back to the latest). */
export async function getEffectiveSteps(rotationPk: number, onDate: string): Promise<{ cycleType: CycleType; steps: PatternStep[] } | null> {
  const version = await query<any[]>(
    `SELECT id, cycle_type FROM hr_shift_rotation_versions WHERE rotation_id = ? AND effective_from <= ?
     ORDER BY effective_from DESC, version_no DESC LIMIT 1`,
    [rotationPk, onDate],
  )
  const chosen = version[0] ||
    (await query<any[]>(`SELECT id, cycle_type FROM hr_shift_rotation_versions WHERE rotation_id = ? ORDER BY version_no ASC LIMIT 1`, [rotationPk]))[0]
  if (!chosen) return null
  const seqs = await query<any[]>(
    `SELECT s.shift_id, s.unit_span, s.duration_days, s.is_weekly_off, s.label, sh.shift_name
     FROM hr_shift_rotation_sequences s LEFT JOIN hr_shifts sh ON sh.id = s.shift_id
     WHERE s.version_id = ? ORDER BY s.sequence_no ASC`,
    [chosen.id],
  )
  return {
    cycleType: chosen.cycle_type as CycleType,
    steps: seqs.map((s) => ({
      shift_id: Number(s.shift_id),
      unit_span: Math.max(1, Number(s.unit_span || s.duration_days || 1)),
      is_weekly_off: Boolean(Number(s.is_weekly_off)),
      shift_name: s.shift_name,
      label: s.label,
    })),
  }
}

function rangesOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  const aEnd = aTo ?? "9999-12-31"
  const bEnd = bTo ?? "9999-12-31"
  return aFrom <= bEnd && bFrom <= aEnd
}
