import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  resolveShiftForEmployee,
  resolveRotationShiftId,
  type ShiftConfig,
} from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Shift Assignments — the AUTHORITATIVE employee->shift relationship layer.
//
// Responsibility boundaries (never crossed here):
//   • Shift Master (hr_shifts)                 → shift rules / policy (read only)
//   • Shift Assignments (this module)          → which employee has which shift
//                                                for which period (the source of
//                                                truth consumed by Attendance,
//                                                Employee Profile and reports)
//   • Shift Change Requests (hr-shift-change)  → request + approval workflow that
//                                                *materializes* an assignment
//   • Rotations                                → recurring schedule (read only)
//   • Attendance                               → actual work (never rewritten here)
//
// This service owns: schema safety, automatic immutable IDs (reusing the shared
// ASM sequence — no second generator), manual-admin creation with transactional
// auto-end of the prior permanent assignment, history preservation, conflict
// detection, source tracking, per-assignment audit, and the current/upcoming
// resolution helpers. All employee/shift/rotation data is *read* from the
// existing masters — never duplicated.
//
// DETERMINISTIC PRECEDENCE (documented once, used everywhere via
// resolveShiftForEmployee in hr-attendance.ts):
//   1. Active explicit assignment covering the date (latest effective_from
//      wins) — this includes assignments materialized from approved shift
//      change requests, so an approved request always beats a rotation.
//   2. Rotation-derived shift (active rotation membership).
//   3. Free-text default `shift` column on the employee (company/default shift).
// Temporary assignments carry an effective_to; once past, resolution falls back
// down the chain automatically without deleting anything.
// ---------------------------------------------------------------------------

/** Shared ERP id sequence — the same prefix approvals already use (ASM-0001). */
export const ASSIGNMENT_ID_PREFIX = "ASM"

export type AssignmentSource = "MANUAL" | "SHIFT_CHANGE_REQUEST" | "ROTATION" | "IMPORT" | "SYSTEM"
export type ChangeType = "Temporary" | "Permanent"

export type Actor = { userId: number; name: string; email: string; role: "admin" | "employee" }

// ---------------------------------------------------------------------------
// Schema safety — additive & idempotent, mirrors the migration so the feature
// works before the SQL file is applied by hand. Every column is nullable /
// defaulted so historical rows and the older generic form keep working.
// ---------------------------------------------------------------------------

let schemaEnsured: Promise<void> | null = null
export function ensureShiftAssignmentSchema(): Promise<void> {
  if (!schemaEnsured) schemaEnsured = doEnsureSchema()
  return schemaEnsured
}

async function addColumn(definition: string) {
  try {
    await query(`ALTER TABLE hr_shift_assignments ADD COLUMN ${definition}`)
  } catch {
    // Column already exists (MySQL lacks ADD COLUMN IF NOT EXISTS) — ignore.
  }
}
async function addIndex(sql: string) {
  try {
    await query(sql)
  } catch {
    // Index already exists.
  }
}

async function doEnsureSchema() {
  await addColumn("`source_type` VARCHAR(40) NOT NULL DEFAULT 'MANUAL'")
  await addColumn("`source_id` VARCHAR(50) DEFAULT NULL")
  // change_type / source_request_id may already exist from the shift-change migration.
  await addColumn("`change_type` ENUM('Temporary','Permanent') NOT NULL DEFAULT 'Permanent'")
  await addColumn("`source_request_id` VARCHAR(50) DEFAULT NULL")
  await addColumn("`assigned_by_name` VARCHAR(150) DEFAULT NULL")
  await addColumn("`ended_by` BIGINT UNSIGNED DEFAULT NULL")
  await addColumn("`ended_at` DATETIME DEFAULT NULL")
  await addColumn("`created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP")
  await addColumn("`updated_at` TIMESTAMP NULL DEFAULT NULL")

  // Backfill provenance for legacy rows created before source tracking existed.
  try {
    await query(
      `UPDATE hr_shift_assignments
         SET source_type = 'SHIFT_CHANGE_REQUEST', source_id = source_request_id
       WHERE source_request_id IS NOT NULL AND (source_type IS NULL OR source_type = 'MANUAL')`,
    )
  } catch {
    // source_request_id column may not exist on very old databases — ignore.
  }

  await addIndex("CREATE INDEX idx_shift_assignment_emp_dates ON hr_shift_assignments (employee_id, effective_from, effective_to)")
  await addIndex("CREATE INDEX idx_shift_assignment_shift_dates ON hr_shift_assignments (shift_id, effective_from, effective_to)")
  await addIndex("CREATE INDEX idx_shift_assignment_status ON hr_shift_assignments (status, effective_from)")

  try {
    await query(`CREATE TABLE IF NOT EXISTS hr_shift_assignment_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      assignment_id VARCHAR(50) NOT NULL,
      employee_id BIGINT UNSIGNED DEFAULT NULL,
      event_type VARCHAR(60) NOT NULL,
      summary VARCHAR(255) NOT NULL,
      changes JSON DEFAULT NULL,
      reason VARCHAR(500) DEFAULT NULL,
      actor_id BIGINT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_shift_assignment_event_ref (assignment_id, created_at),
      KEY idx_shift_assignment_event_emp (employee_id),
      KEY idx_shift_assignment_event_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  } catch (error) {
    console.error("[v0] ensureShiftAssignmentSchema (events table) failed:", (error as Error).message)
  }

  // RBAC features (best-effort).
  try {
    await query(
      `INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
       SELECT id,'Manage Shift Assignments','hr.manage_shift_assignments','Create, edit and end shift assignments',21 FROM modules WHERE slug='hr'`,
    )
    await query(
      `INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
       SELECT id,'Override Shift Assignment Conflicts','hr.override_shift_assignments','Override overlapping/rotation assignment conflicts',22 FROM modules WHERE slug='hr'`,
    )
  } catch {
    // Feature seeding is optional.
  }
}

/** Race-safe, immutable, unique assignment ID (ASM-0001) via the shared sequence. */
export async function nextAssignmentId(): Promise<string> {
  return nextRecordId(ASSIGNMENT_ID_PREFIX, { digits: 4 })
}

// ---------------------------------------------------------------------------
// Read-only masters (Employees + Shifts)
// ---------------------------------------------------------------------------

export type EmployeeContext = {
  id: number
  employee_id: string
  employee_name: string
  department: string | null
  designation: string | null
  reporting_manager: string | null
  employment_status: string | null
  shift: string | null
  joining_date: string | null
  exit_date: string | null
}

export async function getEmployee(id: number): Promise<EmployeeContext | null> {
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, department, designation, reporting_manager,
            employment_status, shift, joining_date, exit_date
     FROM hr_employees WHERE id = ? LIMIT 1`,
    [id],
  )
  return (rows[0] as EmployeeContext) ?? null
}

export async function getEmployeeByEmail(email: string): Promise<EmployeeContext | null> {
  if (!email) return null
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, department, designation, reporting_manager,
            employment_status, shift, joining_date, exit_date
     FROM hr_employees WHERE official_email = ? OR personal_email = ?
     ORDER BY archived_at IS NULL DESC LIMIT 1`,
    [email, email],
  )
  return (rows[0] as EmployeeContext) ?? null
}

export type ShiftMasterRow = {
  id: number
  shift_id: string
  shift_code: string | null
  shift_name: string
  start_time: string
  end_time: string
  is_overnight: boolean
  break_minutes: number
  working_hours: number
  grace_minutes: number
  overtime_enabled: boolean
  overtime_eligible: boolean
  status: string
}

function toShiftMasterRow(row: any): ShiftMasterRow {
  const start = String(row.start_time || "")
  const end = String(row.end_time || "")
  return {
    id: Number(row.id),
    shift_id: row.shift_id,
    shift_code: row.shift_code ?? null,
    shift_name: row.shift_name,
    start_time: start,
    end_time: end,
    is_overnight: Boolean(Number(row.is_overnight)) || end < start,
    break_minutes: Number(row.break_minutes || 0),
    working_hours: Number(row.working_hours || 0),
    grace_minutes: Number(row.grace_minutes ?? 0),
    overtime_enabled: Boolean(Number(row.overtime_enabled)),
    overtime_eligible: row.overtime_eligible == null ? true : Boolean(Number(row.overtime_eligible)),
    status: row.status || "Active",
  }
}

export async function getShift(shiftDbId: number): Promise<ShiftMasterRow | null> {
  const rows = await query<any[]>(`SELECT * FROM hr_shifts WHERE id = ? LIMIT 1`, [shiftDbId])
  return rows[0] ? toShiftMasterRow(rows[0]) : null
}

/** Active shifts for the "New Shift" selector (only assignable shifts). */
export async function listActiveShifts(): Promise<ShiftMasterRow[]> {
  const rows = await query<any[]>(
    `SELECT * FROM hr_shifts WHERE status = 'Active' OR status IS NULL ORDER BY shift_name`,
  )
  return rows.map(toShiftMasterRow)
}

// ---------------------------------------------------------------------------
// Resolution helpers (delegating to the single central engine)
// ---------------------------------------------------------------------------

/** The applicable shift for an employee on a date (central resolver, §5/§51). */
export async function getApplicableShift(
  employee: Pick<EmployeeContext, "id" | "shift">,
  onDate: string,
): Promise<ShiftConfig | null> {
  return resolveShiftForEmployee({ id: employee.id, shift: employee.shift ?? null }, onDate)
}

/** The next scheduled assignment that starts after `onDate` (§52). */
export async function getUpcomingAssignment(employeeId: number, onDate: string): Promise<any | null> {
  const rows = await query<any[]>(
    `SELECT a.*, s.shift_name, s.shift_code, s.start_time, s.end_time, s.is_overnight
     FROM hr_shift_assignments a
     LEFT JOIN hr_shifts s ON s.id = a.shift_id
     WHERE a.employee_id = ? AND a.status = 'Active' AND a.effective_from > ?
     ORDER BY a.effective_from ASC LIMIT 1`,
    [employeeId, onDate],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Derived applicability label (never rely on status alone — §28)
// ---------------------------------------------------------------------------

export type DerivedState = "Active Now" | "Upcoming" | "Historical" | "Inactive"

export function deriveState(row: { status: string; effective_from: string; effective_to: string | null }, today: string): DerivedState {
  if (String(row.status) !== "Active") return "Inactive"
  const from = String(row.effective_from).slice(0, 10)
  const to = row.effective_to ? String(row.effective_to).slice(0, 10) : null
  if (from > today) return "Upcoming"
  if (to && to < today) return "Historical"
  return "Active Now"
}

// ---------------------------------------------------------------------------
// Conflict detection (§6, §8, §15, §16, §42)
// ---------------------------------------------------------------------------

function rangesOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  const aEnd = aTo || "9999-12-31"
  const bEnd = bTo || "9999-12-31"
  return aFrom <= bEnd && bFrom <= aEnd
}

export type AssignmentConflict = {
  errors: string[]
  warnings: string[]
  overlapping: any[]
  rotationConflict: { rotationShiftId: number; rotationShiftName: string } | null
}

/**
 * Detect overlapping active assignments to a *different* shift in the window
 * (hard conflict) and advisory rotation conflicts. For a Permanent change we do
 * not treat an open-ended prior assignment as a hard conflict because creation
 * bounds it automatically; only same-window assignments to a different shift
 * that creation would not cleanly supersede are flagged.
 */
export async function detectAssignmentConflicts(input: {
  employeeId: number
  employeeShift: string | null
  shiftId: number
  changeType: ChangeType
  fromDate: string
  toDate: string | null
  excludeAssignmentId?: string | null
}): Promise<AssignmentConflict> {
  const report: AssignmentConflict = { errors: [], warnings: [], overlapping: [], rotationConflict: null }

  const rows = await query<any[]>(
    `SELECT a.assignment_id, a.shift_id, a.effective_from, a.effective_to, a.change_type, s.shift_name
     FROM hr_shift_assignments a
     LEFT JOIN hr_shifts s ON s.id = a.shift_id
     WHERE a.employee_id = ? AND a.status = 'Active'
       AND (? IS NULL OR a.assignment_id <> ?)`,
    [input.employeeId, input.excludeAssignmentId ?? null, input.excludeAssignmentId ?? null],
  )

  for (const a of rows) {
    if (Number(a.shift_id) === Number(input.shiftId)) continue // same shift = not a conflict
    const aFrom = String(a.effective_from).slice(0, 10)
    const aTo = a.effective_to ? String(a.effective_to).slice(0, 10) : null
    if (!rangesOverlap(input.fromDate, input.toDate, aFrom, aTo)) continue

    // A permanent change that begins after an open-ended/earlier assignment is
    // handled by auto-end; only flag when the existing one starts on/after our
    // start (creation can't cleanly bound it) or when we are Temporary.
    const existingStartsOnOrAfter = aFrom >= input.fromDate
    if (input.changeType === "Temporary" || existingStartsOnOrAfter) {
      report.overlapping.push(a)
    }
  }
  if (report.overlapping.length) {
    const first = report.overlapping[0]
    report.errors.push(
      `Overlaps an existing active assignment (${first.assignment_id}) to ${first.shift_name || "another shift"}. Resolve or override.`,
    )
  }

  // Advisory rotation conflict.
  try {
    const rotationShiftId = await resolveRotationShiftId(input.employeeId, input.fromDate)
    if (rotationShiftId && rotationShiftId !== Number(input.shiftId)) {
      const rs = await getShift(rotationShiftId)
      report.rotationConflict = { rotationShiftId, rotationShiftName: rs?.shift_name || `#${rotationShiftId}` }
      report.warnings.push(
        `An active rotation schedules ${rs?.shift_name || "a different shift"} on ${input.fromDate}; this assignment will override the rotation for its effective period.`,
      )
    }
  } catch {
    // Rotation resolution is advisory — never blocks.
  }

  return report
}

// ---------------------------------------------------------------------------
// Validation (server-side, §38, §39)
// ---------------------------------------------------------------------------

const INACTIVE_STATUSES = new Set(["terminated", "resigned", "exited", "inactive", "left", "archived", "offboarded", "ex-employee"])

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

export type CreateAssignmentInput = {
  employee_id: number
  shift_id: number
  change_type: ChangeType
  effective_from: string
  effective_to: string | null
  notes: string | null
  source_type?: AssignmentSource
  source_id?: string | null
}

export type ValidationResult = { ok: boolean; errors: string[]; conflicts: AssignmentConflict | null }

export async function validateAssignment(
  input: CreateAssignmentInput,
  canOverride: boolean,
): Promise<ValidationResult> {
  const errors: string[] = []

  const employee = await getEmployee(input.employee_id)
  if (!employee) return { ok: false, errors: ["Employee not found."], conflicts: null }

  const status = (employee.employment_status || "").trim().toLowerCase()
  if (INACTIVE_STATUSES.has(status) && !canOverride) {
    errors.push(`Employee is ${employee.employment_status}; a new assignment requires an override.`)
  }
  if (employee.exit_date && input.effective_from > "0000" && !canOverride) {
    const exit = String(employee.exit_date).slice(0, 10)
    if (input.effective_from > exit) errors.push("Effective date is after the employee's exit date.")
  }

  const shift = await getShift(input.shift_id)
  if (!shift) errors.push("Selected shift does not exist.")
  else if (shift.status && shift.status !== "Active" && !canOverride) {
    errors.push("Selected shift is not active and cannot be assigned to a new period.")
  }

  if (!input.effective_from) errors.push("Effective From is required.")
  if (input.change_type === "Temporary") {
    if (!input.effective_to) errors.push("Effective To is required for a temporary assignment.")
    else if (input.effective_to < input.effective_from) errors.push("Effective To cannot be before Effective From.")
  } else if (input.effective_to && input.effective_to < input.effective_from) {
    errors.push("Effective To cannot be before Effective From.")
  }

  let conflicts: AssignmentConflict | null = null
  if (!errors.length && shift) {
    conflicts = await detectAssignmentConflicts({
      employeeId: input.employee_id,
      employeeShift: employee.shift,
      shiftId: input.shift_id,
      changeType: input.change_type,
      fromDate: input.effective_from,
      toDate: input.change_type === "Temporary" ? input.effective_to : input.effective_to,
    })
    if (conflicts.errors.length && !canOverride) errors.push(...conflicts.errors)
  }

  return { ok: errors.length === 0, errors, conflicts }
}

// ---------------------------------------------------------------------------
// Create (manual admin assignment) — transactional, preserves history (§9, §11,
// §26, §43). Auto-ends the prior permanent assignment the day before this one.
// ---------------------------------------------------------------------------

export async function createAssignment(
  input: CreateAssignmentInput,
  actor: Actor,
  canOverride: boolean,
): Promise<{ ok: true; assignmentId: string } | { ok: false; validation: ValidationResult }> {
  await ensureShiftAssignmentSchema()
  const validation = await validateAssignment(input, canOverride)
  if (!validation.ok) return { ok: false, validation }

  const from = input.effective_from
  const to = input.change_type === "Temporary" ? input.effective_to : input.effective_to
  const isTemporary = input.change_type === "Temporary"

  const conn = await pool.getConnection()
  let assignmentId = ""
  try {
    await conn.beginTransaction()

    // History preservation: for a permanent change, bound prior open/earlier
    // active assignments to the day before this one starts, and supersede any
    // active assignments that start on/after the effective date. Temporary
    // changes rely on resolver precedence (latest effective_from within range).
    if (!isTemporary) {
      const [priorOpen] = await conn.query(
        `SELECT id FROM hr_shift_assignments
         WHERE employee_id = ? AND status = 'Active'
           AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?)`,
        [input.employee_id, from, from],
      )
      for (const a of priorOpen as any[]) {
        await conn.query(
          `UPDATE hr_shift_assignments SET effective_to = DATE_SUB(?, INTERVAL 1 DAY), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [from, a.id],
        )
      }
      await conn.query(
        `UPDATE hr_shift_assignments SET status = 'Inactive', updated_at = CURRENT_TIMESTAMP
         WHERE employee_id = ? AND status = 'Active' AND effective_from >= ?`,
        [input.employee_id, from],
      )
    }

    assignmentId = await nextAssignmentId()
    await conn.query(
      `INSERT INTO hr_shift_assignments
         (assignment_id, employee_id, shift_id, effective_from, effective_to, status,
          assigned_by, assigned_by_name, notes, source_type, source_id, source_request_id, change_type, created_at)
       VALUES (?,?,?,?,?, 'Active', ?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`,
      [
        assignmentId,
        input.employee_id,
        input.shift_id,
        from,
        to,
        actor.userId,
        actor.name,
        input.notes ?? null,
        input.source_type ?? "MANUAL",
        input.source_id ?? null,
        input.source_type === "SHIFT_CHANGE_REQUEST" ? input.source_id ?? null : null,
        input.change_type,
      ],
    )

    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  const shift = await getShift(input.shift_id)
  await logAssignmentEvent({
    assignmentId,
    employeeId: input.employee_id,
    type: "created",
    summary: `Assigned ${shift?.shift_name || "shift"} (${input.change_type}) effective ${from}${to ? ` → ${to}` : " onward"}`,
    reason: input.notes ?? null,
    actorId: actor.userId,
    actorName: actor.name,
  })

  return { ok: true, assignmentId }
}

// ---------------------------------------------------------------------------
// End / deactivate / reactivate (§57, §58, §59) — never deletes history.
// ---------------------------------------------------------------------------

export async function endAssignment(
  assignmentId: string,
  effectiveTo: string,
  actor: Actor,
  reason: string | null,
): Promise<{ ok: boolean; error?: string }> {
  await ensureShiftAssignmentSchema()
  const rows = await query<any[]>(`SELECT * FROM hr_shift_assignments WHERE assignment_id = ? LIMIT 1`, [assignmentId])
  const a = rows[0]
  if (!a) return { ok: false, error: "Assignment not found." }
  if (effectiveTo < String(a.effective_from).slice(0, 10)) {
    return { ok: false, error: "End date cannot be before the assignment starts." }
  }
  await query(
    `UPDATE hr_shift_assignments SET effective_to = ?, ended_by = ?, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE assignment_id = ?`,
    [effectiveTo, actor.userId, assignmentId],
  )
  await logAssignmentEvent({
    assignmentId,
    employeeId: Number(a.employee_id),
    type: "ended",
    summary: `Assignment ended effective ${effectiveTo}`,
    changes: [{ field: "effective_to", label: "Effective To", from: a.effective_to ?? null, to: effectiveTo }],
    reason,
    actorId: actor.userId,
    actorName: actor.name,
  })
  return { ok: true }
}

export async function setAssignmentStatus(
  assignmentId: string,
  status: "Active" | "Inactive",
  actor: Actor,
  reason: string | null,
): Promise<{ ok: boolean; error?: string }> {
  await ensureShiftAssignmentSchema()
  const rows = await query<any[]>(`SELECT * FROM hr_shift_assignments WHERE assignment_id = ? LIMIT 1`, [assignmentId])
  const a = rows[0]
  if (!a) return { ok: false, error: "Assignment not found." }

  // Reactivation must not resurrect a conflict (§59).
  if (status === "Active" && a.status !== "Active") {
    const conflicts = await detectAssignmentConflicts({
      employeeId: Number(a.employee_id),
      employeeShift: null,
      shiftId: Number(a.shift_id),
      changeType: (a.change_type as ChangeType) || "Permanent",
      fromDate: String(a.effective_from).slice(0, 10),
      toDate: a.effective_to ? String(a.effective_to).slice(0, 10) : null,
      excludeAssignmentId: assignmentId,
    })
    if (conflicts.errors.length) return { ok: false, error: conflicts.errors[0] }
  }

  await query(
    `UPDATE hr_shift_assignments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE assignment_id = ?`,
    [status, assignmentId],
  )
  await logAssignmentEvent({
    assignmentId,
    employeeId: Number(a.employee_id),
    type: status === "Active" ? "activated" : "deactivated",
    summary: status === "Active" ? "Assignment reactivated" : "Assignment deactivated",
    changes: [{ field: "status", label: "Status", from: a.status, to: status }],
    reason,
    actorId: actor.userId,
    actorName: actor.name,
  })
  return { ok: true }
}

/** Editable fields for an existing assignment (dates/notes only — never id/employee/assigned_by). */
export async function updateAssignment(
  assignmentId: string,
  patch: { effective_from?: string; effective_to?: string | null; notes?: string | null; change_type?: ChangeType },
  actor: Actor,
  canOverride: boolean,
): Promise<{ ok: boolean; error?: string }> {
  await ensureShiftAssignmentSchema()
  const rows = await query<any[]>(`SELECT * FROM hr_shift_assignments WHERE assignment_id = ? LIMIT 1`, [assignmentId])
  const a = rows[0]
  if (!a) return { ok: false, error: "Assignment not found." }

  const merged = {
    effective_from: patch.effective_from ?? String(a.effective_from).slice(0, 10),
    effective_to:
      patch.effective_to === undefined ? (a.effective_to ? String(a.effective_to).slice(0, 10) : null) : patch.effective_to,
    change_type: (patch.change_type ?? a.change_type ?? "Permanent") as ChangeType,
  }
  if (merged.effective_to && merged.effective_to < merged.effective_from) {
    return { ok: false, error: "Effective To cannot be before Effective From." }
  }

  if (a.status === "Active") {
    const conflicts = await detectAssignmentConflicts({
      employeeId: Number(a.employee_id),
      employeeShift: null,
      shiftId: Number(a.shift_id),
      changeType: merged.change_type,
      fromDate: merged.effective_from,
      toDate: merged.effective_to,
      excludeAssignmentId: assignmentId,
    })
    if (conflicts.errors.length && !canOverride) return { ok: false, error: conflicts.errors[0] }
  }

  const changes: AssignmentFieldChange[] = []
  const sets: string[] = []
  const params: any[] = []
  if (patch.effective_from !== undefined && merged.effective_from !== String(a.effective_from).slice(0, 10)) {
    sets.push("effective_from = ?"); params.push(merged.effective_from)
    changes.push({ field: "effective_from", label: "Effective From", from: a.effective_from, to: merged.effective_from })
  }
  if (patch.effective_to !== undefined) {
    const cur = a.effective_to ? String(a.effective_to).slice(0, 10) : null
    if (merged.effective_to !== cur) {
      sets.push("effective_to = ?"); params.push(merged.effective_to)
      changes.push({ field: "effective_to", label: "Effective To", from: cur, to: merged.effective_to })
    }
  }
  if (patch.change_type !== undefined && merged.change_type !== a.change_type) {
    sets.push("change_type = ?"); params.push(merged.change_type)
    changes.push({ field: "change_type", label: "Type", from: a.change_type, to: merged.change_type })
  }
  if (patch.notes !== undefined && (patch.notes ?? null) !== (a.notes ?? null)) {
    sets.push("notes = ?"); params.push(patch.notes ?? null)
    changes.push({ field: "notes", label: "Notes", from: a.notes ?? null, to: patch.notes ?? null })
  }
  if (!sets.length) return { ok: true }

  sets.push("updated_at = CURRENT_TIMESTAMP")
  params.push(assignmentId)
  await query(`UPDATE hr_shift_assignments SET ${sets.join(", ")} WHERE assignment_id = ?`, params)
  await logAssignmentEvent({
    assignmentId,
    employeeId: Number(a.employee_id),
    type: "updated",
    summary: `Updated ${changes.map((c) => c.label).join(", ")}`,
    changes,
    actorId: actor.userId,
    actorName: actor.name,
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Audit (§35) — reuse the per-domain event pattern.
// ---------------------------------------------------------------------------

export type AssignmentFieldChange = { field: string; label: string; from: unknown; to: unknown }

export async function logAssignmentEvent(opts: {
  assignmentId: string
  employeeId?: number | null
  type: string
  summary: string
  changes?: AssignmentFieldChange[] | null
  reason?: string | null
  actorId?: number | null
  actorName?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO hr_shift_assignment_events
         (assignment_id, employee_id, event_type, summary, changes, reason, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        opts.assignmentId,
        opts.employeeId ?? null,
        opts.type,
        opts.summary,
        opts.changes && opts.changes.length ? JSON.stringify(opts.changes) : null,
        opts.reason ?? null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] logAssignmentEvent failed:", (error as Error).message)
  }
}

export async function getAssignmentEvents(assignmentId: string): Promise<any[]> {
  try {
    return await query<any[]>(
      `SELECT id, event_type, summary, changes, reason, actor_name, created_at
       FROM hr_shift_assignment_events WHERE assignment_id = ? ORDER BY id DESC LIMIT 100`,
      [assignmentId],
    )
  } catch {
    return []
  }
}

/** Timeline of every assignment change for one employee (§34). */
export async function getEmployeeAssignmentTimeline(employeeId: number): Promise<any[]> {
  try {
    return await query<any[]>(
      `SELECT e.id, e.assignment_id, e.event_type, e.summary, e.reason, e.actor_name, e.created_at,
              a.effective_from, a.effective_to, s.shift_name
       FROM hr_shift_assignment_events e
       LEFT JOIN hr_shift_assignments a ON a.assignment_id = e.assignment_id
       LEFT JOIN hr_shifts s ON s.id = a.shift_id
       WHERE e.employee_id = ? ORDER BY e.id DESC LIMIT 200`,
      [employeeId],
    )
  } catch {
    return []
  }
}
