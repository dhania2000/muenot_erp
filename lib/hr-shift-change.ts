import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { resolveShiftForEmployee, type ShiftConfig } from "@/lib/hr-attendance"
import { deriveManager, notifyByEmail, type EmployeeLite } from "@/lib/hr-leave"

// ---------------------------------------------------------------------------
// Shift Change Requests — the controlled workflow that turns an employee's
// request into an approved Shift Assignment.
//
// Responsibility boundaries (do not cross them):
//   • Shift Master (hr_shifts)              → shift rules / policy (read only)
//   • Shift Assignments (hr_shift_assignments) → the final employee↔shift link
//   • Shift Change Requests (this module)   → request + approval workflow
//   • Rotations                             → recurring schedule (read only)
//   • Attendance                            → actual work (never rewritten here)
//
// This service owns: schema safety, automatic IDs, employee/shift context,
// current-shift + rotation resolution, conflict detection, the approval →
// assignment automation, cancellation/reversion, timeline + audit, and email
// notifications. All of these reuse existing ERP services rather than
// duplicating employees, shift master, assignments, rotations or attendance.
// ---------------------------------------------------------------------------

export const SCR_ID_PREFIX = "SCR"
export const ASSIGNMENT_ID_PREFIX = "ASM"

export type Actor = { userId: number; name: string; email: string; role: "admin" | "employee" }

/** Employment statuses that are not eligible for a normal future shift change. */
const INACTIVE_STATUSES = new Set(["terminated", "resigned", "exited", "inactive", "left", "archived", "offboarded"])

// ---------------------------------------------------------------------------
// Schema safety (idempotent, mirrors the migration)
// ---------------------------------------------------------------------------

let schemaEnsured: Promise<void> | null = null
export function ensureShiftChangeSchema(): Promise<void> {
  if (!schemaEnsured) schemaEnsured = doEnsureSchema()
  return schemaEnsured
}

async function addColumn(table: string, definition: string) {
  try {
    await query(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  } catch {
    // Column already exists — MySQL lacks ADD COLUMN IF NOT EXISTS.
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
  await addColumn("hr_shift_change_requests", "`employee_name` VARCHAR(150) DEFAULT NULL")
  await addColumn(
    "hr_shift_change_requests",
    "`change_type` ENUM('Temporary','Permanent') NOT NULL DEFAULT 'Permanent'",
  )
  await addColumn("hr_shift_change_requests", "`reason_category` VARCHAR(60) DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`attachment_url` VARCHAR(500) DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`attachment_name` VARCHAR(255) DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`approver_id` BIGINT UNSIGNED DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`approver_name` VARCHAR(150) DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`created_by` BIGINT UNSIGNED DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP")
  await addColumn("hr_shift_change_requests", "`updated_at` TIMESTAMP NULL DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`applied_assignment_id` VARCHAR(50) DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`cancelled_at` DATETIME NULL DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`cancelled_by` BIGINT UNSIGNED DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`cancel_reason` VARCHAR(500) DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`withdrawn_at` DATETIME NULL DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`support_ticket_id` VARCHAR(50) DEFAULT NULL")
  await addColumn("hr_shift_change_requests", "`is_override` TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("hr_shift_change_requests", "`override_reason` VARCHAR(500) DEFAULT NULL")

  // Extend the lifecycle enum to include Withdrawn (safe re-run).
  try {
    await query(
      `ALTER TABLE hr_shift_change_requests
       MODIFY COLUMN status ENUM('Pending','Approved','Rejected','Cancelled','Withdrawn') NOT NULL DEFAULT 'Pending'`,
    )
  } catch (error) {
    console.error("[v0] ensureShiftChangeSchema (status enum) failed:", (error as Error).message)
  }

  await addIndex("CREATE INDEX idx_scr_status ON hr_shift_change_requests (status)")
  await addIndex("CREATE INDEX idx_scr_dates ON hr_shift_change_requests (employee_id, from_date, to_date)")

  await addColumn("hr_shift_assignments", "`source_request_id` VARCHAR(50) DEFAULT NULL")
  await addColumn("hr_shift_assignments", "`change_type` ENUM('Temporary','Permanent') DEFAULT NULL")
  await addIndex("CREATE INDEX idx_shift_assignment_source ON hr_shift_assignments (source_request_id)")

  try {
    await query(`CREATE TABLE IF NOT EXISTS hr_shift_change_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      request_id VARCHAR(50) NOT NULL,
      employee_id BIGINT UNSIGNED DEFAULT NULL,
      event_type VARCHAR(60) NOT NULL,
      message VARCHAR(500) NOT NULL,
      changes JSON DEFAULT NULL,
      actor_id BIGINT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_scr_event_request (request_id, created_at),
      KEY idx_scr_event_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  } catch (error) {
    console.error("[v0] ensureShiftChangeSchema (events table) failed:", (error as Error).message)
  }

  // RBAC features (best-effort; ignored if the module/features tables differ).
  try {
    await query(
      `INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
       SELECT id,'Manage Shift Change Requests','hr.manage_shift_change_requests','Approve, reject and cancel shift change requests',19 FROM modules WHERE slug='hr'`,
    )
    await query(
      `INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
       SELECT id,'Override Shift Change Rules','hr.override_shift_change_requests','Override conflicts / backdated shift changes',20 FROM modules WHERE slug='hr'`,
    )
  } catch {
    // Feature seeding is optional.
  }
}

/** Race-safe, immutable, unique request ID (SCR-000001). */
export async function nextShiftChangeId(): Promise<string> {
  return nextRecordId(SCR_ID_PREFIX, { digits: 6 })
}

// ---------------------------------------------------------------------------
// Employees + shifts (read-only views over the existing masters)
// ---------------------------------------------------------------------------

export type EmployeeContextRow = EmployeeLite & { shift: string | null }

/** Full employee record incl. the free-text `shift` column used by the resolver. */
export async function getEmployeeFull(id: number | string): Promise<EmployeeContextRow | null> {
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, department, designation, reporting_manager,
            gender, employment_type, official_email, personal_email, joining_date, employment_status, shift
     FROM hr_employees WHERE id = ? LIMIT 1`,
    [id],
  )
  return (rows[0] as EmployeeContextRow) ?? null
}

/** Self-service identity — match the authenticated user's email to an employee. */
export async function getEmployeeByEmailFull(email: string): Promise<EmployeeContextRow | null> {
  if (!email) return null
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, department, designation, reporting_manager,
            gender, employment_type, official_email, personal_email, joining_date, employment_status, shift
     FROM hr_employees WHERE official_email = ? OR personal_email = ? ORDER BY archived_at IS NULL DESC LIMIT 1`,
    [email, email],
  )
  return (rows[0] as EmployeeContextRow) ?? null
}

export type ShiftDetail = {
  id: number
  shift_id: string
  shift_code: string | null
  shift_name: string
  start_time: string
  end_time: string
  is_overnight: boolean
  break_minutes: number
  working_hours: number
  overtime_enabled: boolean
  overtime_eligible: boolean
  status: string
}

function toShiftDetail(row: any): ShiftDetail {
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
    overtime_enabled: Boolean(Number(row.overtime_enabled)),
    overtime_eligible: row.overtime_eligible == null ? true : Boolean(Number(row.overtime_eligible)),
    status: row.status || "Active",
  }
}

/** Requested-shift details straight from Shift Master (source of truth). */
export async function getShiftDetail(shiftDbId: number): Promise<ShiftDetail | null> {
  const rows = await query<any[]>(`SELECT * FROM hr_shifts WHERE id = ? LIMIT 1`, [shiftDbId])
  return rows[0] ? toShiftDetail(rows[0]) : null
}

/** Active shifts for the requested-shift selector. */
export async function listActiveShifts(): Promise<ShiftDetail[]> {
  const rows = await query<any[]>(
    `SELECT * FROM hr_shifts WHERE status = 'Active' OR status IS NULL ORDER BY shift_name`,
  )
  return rows.map(toShiftDetail)
}

// ---------------------------------------------------------------------------
// Current + rotation shift resolution
// ---------------------------------------------------------------------------

/** The shift that applies to an employee on a date — reuses the central resolver. */
export async function resolveCurrentShift(
  employee: Pick<EmployeeContextRow, "id" | "shift">,
  onDate: string,
): Promise<ShiftConfig | null> {
  return resolveShiftForEmployee({ id: employee.id, shift: employee.shift ?? null }, onDate)
}

/**
 * Deterministic rotation resolver used only for CONFLICT DETECTION (advisory).
 * Rule: from the employee's active rotation membership, count days since the
 * membership start_date, take that modulo the rotation's total cycle length
 * (sum of sequence durations), then walk the ordered sequences to find the
 * shift that covers that offset. Returns the Shift Master db id, or null when
 * the employee is not on a rotation or it cannot be resolved.
 */
export async function resolveRotationShift(
  employeeId: number,
  onDate: string,
): Promise<{ shiftId: number; rotationName: string } | null> {
  try {
    const memberRows = await query<any[]>(
      `SELECT re.start_date, r.id AS rotation_pk, r.rotation_name, r.status
       FROM hr_shift_rotation_employees re
       JOIN hr_shift_rotations r ON r.id = re.rotation_id
       WHERE re.employee_id = ? AND re.status = 'Active' AND r.status = 'Active'
       ORDER BY re.start_date DESC LIMIT 1`,
      [employeeId],
    )
    const member = memberRows[0]
    if (!member) return null

    const sequences = await query<any[]>(
      `SELECT shift_id, duration_days FROM hr_shift_rotation_sequences
       WHERE rotation_id = ? ORDER BY sequence_no ASC`,
      [member.rotation_pk],
    )
    if (!sequences.length) return null

    const totalDays = sequences.reduce((sum, s) => sum + Math.max(1, Number(s.duration_days || 1)), 0)
    if (totalDays <= 0) return null

    const start = new Date(`${String(member.start_date).slice(0, 10)}T00:00:00`)
    const target = new Date(`${onDate}T00:00:00`)
    const daysSince = Math.floor((target.getTime() - start.getTime()) / 86400000)
    if (daysSince < 0) return null

    let offset = daysSince % totalDays
    for (const seq of sequences) {
      const dur = Math.max(1, Number(seq.duration_days || 1))
      if (offset < dur) return { shiftId: Number(seq.shift_id), rotationName: member.rotation_name }
      offset -= dur
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Conflict / validation detection
// ---------------------------------------------------------------------------

export type ConflictReport = {
  errors: string[]
  warnings: string[]
  overlappingRequests: any[]
  conflictingAssignments: any[]
  rotationConflict: { rotationName: string; rotationShift: string } | null
}

/** Two closed/open date ranges overlap. `to` null means open-ended. */
function rangesOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  const aEnd = aTo || "9999-12-31"
  const bEnd = bTo || "9999-12-31"
  return aFrom <= bEnd && bFrom <= aEnd
}

export async function detectConflicts(input: {
  employeeId: number
  employeeShift: string | null
  fromDate: string
  toDate: string | null
  requestedShiftId: number
  excludeRequestId?: string | null
}): Promise<ConflictReport> {
  const report: ConflictReport = {
    errors: [],
    warnings: [],
    overlappingRequests: [],
    conflictingAssignments: [],
    rotationConflict: null,
  }

  // 1. Overlapping pending/approved requests (spec §20, §21).
  const others = await query<any[]>(
    `SELECT r.request_id, r.from_date, r.to_date, r.status, r.requested_shift_id, s.shift_name
     FROM hr_shift_change_requests r
     LEFT JOIN hr_shifts s ON s.id = r.requested_shift_id
     WHERE r.employee_id = ? AND r.status IN ('Pending','Approved')
       AND (? IS NULL OR r.request_id <> ?)`,
    [input.employeeId, input.excludeRequestId ?? null, input.excludeRequestId ?? null],
  )
  for (const o of others) {
    const oTo = o.to_date ? String(o.to_date).slice(0, 10) : null
    if (rangesOverlap(input.fromDate, input.toDate, String(o.from_date).slice(0, 10), oTo)) {
      report.overlappingRequests.push(o)
    }
  }
  if (report.overlappingRequests.length) {
    report.errors.push(
      `Overlaps an existing ${report.overlappingRequests[0].status.toLowerCase()} request (${report.overlappingRequests[0].request_id}).`,
    )
  }

  // 2. Conflicting active assignments to a different shift in the window (§6, §19).
  const assignments = await query<any[]>(
    `SELECT a.assignment_id, a.shift_id, a.effective_from, a.effective_to, s.shift_name
     FROM hr_shift_assignments a
     LEFT JOIN hr_shifts s ON s.id = a.shift_id
     WHERE a.employee_id = ? AND a.status = 'Active' AND a.shift_id <> ?`,
    [input.employeeId, input.requestedShiftId],
  )
  for (const a of assignments) {
    const aTo = a.effective_to ? String(a.effective_to).slice(0, 10) : null
    if (rangesOverlap(input.fromDate, input.toDate, String(a.effective_from).slice(0, 10), aTo)) {
      report.conflictingAssignments.push(a)
    }
  }
  if (report.conflictingAssignments.length) {
    // Advisory — approval supersedes the prior assignment while keeping history.
    report.warnings.push(
      `Employee already has an assignment to ${report.conflictingAssignments[0].shift_name || "another shift"} in this period; approval will supersede it.`,
    )
  }

  // 3. Rotation conflict (advisory, deterministic — §19).
  const rotation = await resolveRotationShift(input.employeeId, input.fromDate)
  if (rotation && rotation.shiftId !== input.requestedShiftId) {
    const rs = await getShiftDetail(rotation.shiftId)
    report.rotationConflict = { rotationName: rotation.rotationName, rotationShift: rs?.shift_name || `#${rotation.shiftId}` }
    report.warnings.push(
      `Rotation "${rotation.rotationName}" schedules ${rs?.shift_name || "a different shift"} on ${input.fromDate}. This change will override the rotation for the effective period.`,
    )
  }

  return report
}

// ---------------------------------------------------------------------------
// Timeline + audit
// ---------------------------------------------------------------------------

export async function logEvent(opts: {
  requestId: string
  employeeId?: number | null
  type: string
  message: string
  changes?: Record<string, { from: unknown; to: unknown }> | null
  actorId?: number | null
  actorName?: string | null
}) {
  try {
    await query(
      `INSERT INTO hr_shift_change_events (request_id, employee_id, event_type, message, changes, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?)`,
      [
        opts.requestId,
        opts.employeeId ?? null,
        opts.type,
        opts.message,
        opts.changes && Object.keys(opts.changes).length ? JSON.stringify(opts.changes) : null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] shift-change logEvent failed:", (error as Error).message)
  }
}

export async function getTimeline(requestId: string): Promise<any[]> {
  try {
    return await query<any[]>(
      `SELECT id, event_type, message, changes, actor_name, created_at
       FROM hr_shift_change_events WHERE request_id = ? ORDER BY id ASC`,
      [requestId],
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Validation shared by create + approve
// ---------------------------------------------------------------------------

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

export type CreateInput = {
  employee_id: number
  requested_shift_id: number
  change_type: "Temporary" | "Permanent"
  from_date: string
  to_date: string | null
  reason_category: string | null
  reason: string
  attachment_url?: string | null
  attachment_name?: string | null
  support_ticket_id?: string | null
  is_override?: boolean
  override_reason?: string | null
}

export type ValidationResult = {
  ok: boolean
  errors: string[]
  conflicts: ConflictReport | null
}

/** Field + date + policy validation. `canOverride` relaxes backdating/conflicts. */
export async function validateRequest(input: CreateInput, canOverride: boolean): Promise<ValidationResult> {
  const errors: string[] = []

  const employee = await getEmployeeFull(input.employee_id)
  if (!employee) return { ok: false, errors: ["Employee not found."], conflicts: null }

  // Employment eligibility (§30).
  const status = (employee.employment_status || "").trim().toLowerCase()
  if (INACTIVE_STATUSES.has(status) && !canOverride) {
    errors.push(`Employee is ${employee.employment_status}; shift changes require an override.`)
  }

  // Requested shift must be a valid, active shift from the master (§32).
  const shift = await getShiftDetail(input.requested_shift_id)
  if (!shift) errors.push("Requested shift does not exist.")
  else if (shift.status && shift.status !== "Active" && !canOverride) {
    errors.push("Requested shift is not active.")
  }

  if (!input.reason || !input.reason.trim()) errors.push("A reason is required.")
  if (input.reason_category === "Other" && (!input.reason || input.reason.trim().length < 5)) {
    errors.push("Please provide a meaningful explanation for 'Other'.")
  }

  // Date validation (§6).
  if (!input.from_date) errors.push("Effective From is required.")
  if (input.change_type === "Temporary") {
    if (!input.to_date) errors.push("Effective To is required for a temporary change.")
    else if (input.to_date < input.from_date) errors.push("Effective To cannot be before Effective From.")
  }
  // Backdating (§28) — blocked unless override.
  if (input.from_date && input.from_date < todayStr() && !canOverride) {
    errors.push("Backdated shift changes are not allowed. Use a historical correction workflow or an override.")
  }

  let conflicts: ConflictReport | null = null
  if (!errors.length && shift) {
    conflicts = await detectConflicts({
      employeeId: input.employee_id,
      employeeShift: employee.shift,
      fromDate: input.from_date,
      toDate: input.change_type === "Temporary" ? input.to_date : null,
      requestedShiftId: input.requested_shift_id,
    })
    // Hard conflicts (overlapping requests) block unless override.
    if (conflicts.errors.length && !canOverride) errors.push(...conflicts.errors)
  }

  return { ok: errors.length === 0, errors, conflicts }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createShiftChangeRequest(input: CreateInput, actor: Actor, canOverride: boolean) {
  await ensureShiftChangeSchema()
  const validation = await validateRequest(input, canOverride)
  if (!validation.ok) return { ok: false as const, validation }

  const employee = (await getEmployeeFull(input.employee_id))!
  const manager = await deriveManager(employee as unknown as EmployeeLite)
  const currentShift = await resolveCurrentShift(employee, input.from_date)
  const requestId = await nextShiftChangeId()
  const toDate = input.change_type === "Temporary" ? input.to_date : null

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `INSERT INTO hr_shift_change_requests
        (request_id, employee_id, employee_name, current_shift_id, requested_shift_id,
         change_type, from_date, to_date, reason_category, reason, attachment_url, attachment_name,
         support_ticket_id, status, approver_id, approver_name, created_by, created_at,
         is_override, override_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'Pending', ?,?,?, CURRENT_TIMESTAMP, ?, ?)`,
      [
        requestId,
        employee.id,
        employee.employee_name,
        currentShift?.id ?? null,
        input.requested_shift_id,
        input.change_type,
        input.from_date,
        toDate,
        input.reason_category ?? null,
        input.reason,
        input.attachment_url ?? null,
        input.attachment_name ?? null,
        input.support_ticket_id ?? null,
        manager?.id ?? null,
        manager?.employee_name ?? employee.reporting_manager ?? null,
        actor.userId,
        input.is_override ? 1 : 0,
        input.override_reason ?? null,
      ],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  const requestedShift = await getShiftDetail(input.requested_shift_id)
  await logEvent({
    requestId,
    employeeId: employee.id,
    type: "created",
    message: `${employee.employee_name} requested a ${input.change_type.toLowerCase()} change to ${requestedShift?.shift_name || "a shift"} effective ${input.from_date}${toDate ? ` → ${toDate}` : " onward"}.`,
    actorId: actor.userId,
    actorName: actor.name,
  })
  if (manager) {
    await logEvent({
      requestId,
      employeeId: employee.id,
      type: "approver_assigned",
      message: `Approver assigned: ${manager.employee_name}.`,
      actorId: actor.userId,
      actorName: actor.name,
    })
  }

  // Notify the approver (best-effort, existing mail service).
  const managerEmail = manager?.official_email || manager?.personal_email
  await notifyByEmail(
    managerEmail,
    `Shift change approval needed — ${employee.employee_name}`,
    shell(
      "New shift change request",
      `<p><strong>${employee.employee_name}</strong> requested a <strong>${input.change_type}</strong> shift change.</p>
       <p>Requested shift: <strong>${requestedShift?.shift_name || "—"}</strong> (${requestedShift?.start_time || ""}–${requestedShift?.end_time || ""})</p>
       <p>Effective: ${input.from_date}${toDate ? ` → ${toDate}` : " onward"}</p>
       <p>Reason: ${input.reason}</p>
       <p>Please review in the HR portal (ref ${requestId}).</p>`,
    ),
  )

  return { ok: true as const, requestId, validation }
}

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

export type RequestAction = "approve" | "reject" | "withdraw" | "cancel"

const ALLOWED_FROM: Record<RequestAction, string[]> = {
  approve: ["Pending"],
  reject: ["Pending"],
  withdraw: ["Pending"],
  cancel: ["Pending", "Approved"],
}

/** Apply an approved change to Shift Assignments, preserving history (§13-15). */
async function applyAssignment(
  conn: any,
  request: any,
  actor: Actor,
): Promise<string> {
  const from = String(request.from_date).slice(0, 10)
  const to = request.to_date ? String(request.to_date).slice(0, 10) : null
  const isTemporary = request.change_type === "Temporary"

  // Preserve history: bound / supersede prior active assignments rather than
  // deleting them. For a permanent change, open-ended prior assignments are
  // closed the day before the new one starts; assignments starting on/after
  // the effective date are marked Inactive (superseded). For a temporary
  // change we rely on resolver precedence (latest effective_from within range
  // wins), so we only need to insert the bounded window.
  if (!isTemporary) {
    const priorOpen = await conn.query(
      `SELECT id, effective_from, effective_to FROM hr_shift_assignments
       WHERE employee_id = ? AND status = 'Active'
         AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?)`,
      [request.employee_id, from, from],
    )
    for (const a of priorOpen[0] as any[]) {
      await conn.query(`UPDATE hr_shift_assignments SET effective_to = DATE_SUB(?, INTERVAL 1 DAY) WHERE id = ?`, [
        from,
        a.id,
      ])
    }
    await conn.query(
      `UPDATE hr_shift_assignments SET status = 'Inactive'
       WHERE employee_id = ? AND status = 'Active' AND effective_from >= ?`,
      [request.employee_id, from],
    )
  }

  const assignmentId = await nextRecordId(ASSIGNMENT_ID_PREFIX, { digits: 4 })
  await conn.query(
    `INSERT INTO hr_shift_assignments
       (assignment_id, employee_id, shift_id, effective_from, effective_to, status, assigned_by, notes, source_request_id, change_type)
     VALUES (?,?,?,?,?,'Active',?,?,?,?)`,
    [
      assignmentId,
      request.employee_id,
      request.requested_shift_id,
      from,
      to,
      actor.userId,
      `Auto-created from approved shift change ${request.request_id}`,
      request.request_id,
      request.change_type,
    ],
  )
  return assignmentId
}

/** Reverse a future-dated approved change on cancellation (§27, §60). */
async function revertAssignment(conn: any, request: any): Promise<"reverted" | "kept"> {
  if (!request.applied_assignment_id) return "kept"
  const rows = await conn.query(`SELECT * FROM hr_shift_assignments WHERE assignment_id = ? LIMIT 1`, [
    request.applied_assignment_id,
  ])
  const assignment = (rows[0] as any[])[0]
  if (!assignment) return "kept"

  const from = String(assignment.effective_from).slice(0, 10)
  // Already effective — do NOT rewrite history. Leave the assignment in place.
  if (from <= todayStr()) return "kept"

  // Not yet effective: deactivate the future assignment (kept for history) and
  // restore the prior assignment we had bounded to the day before it started.
  await conn.query(
    `UPDATE hr_shift_assignments SET status = 'Inactive', notes = CONCAT(COALESCE(notes,''), ' | Reverted by cancellation of ', ?) WHERE assignment_id = ?`,
    [request.request_id, request.applied_assignment_id],
  )
  const prevEnd = new Date(`${from}T00:00:00`)
  prevEnd.setDate(prevEnd.getDate() - 1)
  const prevEndStr = prevEnd.toISOString().slice(0, 10)
  const restoreTo = assignment.effective_to ? String(assignment.effective_to).slice(0, 10) : null
  await conn.query(
    `UPDATE hr_shift_assignments SET effective_to = ?
     WHERE employee_id = ? AND status = 'Active' AND effective_to = ?`,
    [restoreTo, assignment.employee_id, prevEndStr],
  )
  return "reverted"
}

export async function transitionRequest(
  requestId: string,
  action: RequestAction,
  actor: Actor,
  opts: { remarks?: string | null; canOverride?: boolean } = {},
) {
  await ensureShiftChangeSchema()
  const rows = await query<any[]>(`SELECT * FROM hr_shift_change_requests WHERE request_id = ? LIMIT 1`, [requestId])
  const request = rows[0]
  if (!request) return { ok: false as const, error: "Request not found", status: 404 }

  if (!ALLOWED_FROM[action].includes(request.status)) {
    return { ok: false as const, error: `Cannot ${action} a request that is ${request.status}.`, status: 409 }
  }

  // Self-approval block — enforced on the backend (§11).
  if ((action === "approve" || action === "reject") && actor.role !== "admin") {
    if (Number(request.created_by) === Number(actor.userId)) {
      return { ok: false as const, error: "You cannot approve or reject your own request.", status: 403 }
    }
  }

  if (action === "reject" && !(opts.remarks && opts.remarks.trim())) {
    return { ok: false as const, error: "A rejection reason is required.", status: 422 }
  }

  const remarks = opts.remarks ?? null
  let appliedAssignmentId: string | null = null
  let reversion: "reverted" | "kept" | null = null

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Re-lock the row to avoid double-processing (double-click / retry safety).
    const locked = await conn.query(
      `SELECT * FROM hr_shift_change_requests WHERE request_id = ? FOR UPDATE`,
      [requestId],
    )
    const current = (locked[0] as any[])[0]
    if (!ALLOWED_FROM[action].includes(current.status)) {
      await conn.rollback()
      return { ok: false as const, error: `Request already ${current.status}.`, status: 409 }
    }

    if (action === "approve") {
      // Re-validate conflicts at approval time; block hard conflicts unless override.
      const conflicts = await detectConflicts({
        employeeId: Number(current.employee_id),
        employeeShift: null,
        fromDate: String(current.from_date).slice(0, 10),
        toDate: current.to_date ? String(current.to_date).slice(0, 10) : null,
        requestedShiftId: Number(current.requested_shift_id),
        excludeRequestId: requestId,
      })
      if (conflicts.errors.length && !opts.canOverride) {
        await conn.rollback()
        return { ok: false as const, error: conflicts.errors[0], status: 409 }
      }
      appliedAssignmentId = await applyAssignment(conn, current, actor)
      await conn.query(
        `UPDATE hr_shift_change_requests SET
           status = 'Approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
           review_remarks = ?, approver_id = COALESCE(approver_id, ?), approver_name = COALESCE(approver_name, ?),
           applied_assignment_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE request_id = ?`,
        [actor.userId, remarks, actor.userId, actor.name, appliedAssignmentId, requestId],
      )
    } else if (action === "reject") {
      await conn.query(
        `UPDATE hr_shift_change_requests SET
           status = 'Rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
           review_remarks = ?, updated_at = CURRENT_TIMESTAMP
         WHERE request_id = ?`,
        [actor.userId, remarks, requestId],
      )
    } else if (action === "withdraw") {
      await conn.query(
        `UPDATE hr_shift_change_requests SET status = 'Withdrawn', withdrawn_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?`,
        [requestId],
      )
    } else if (action === "cancel") {
      if (current.status === "Approved") {
        reversion = await revertAssignment(conn, current)
      }
      await conn.query(
        `UPDATE hr_shift_change_requests SET
           status = 'Cancelled', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ?,
           cancel_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE request_id = ?`,
        [actor.userId, remarks, requestId],
      )
    }

    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  // Timeline + audit (outside the transaction; never breaks the operation).
  const messages: Record<RequestAction, string> = {
    approve: `Request approved${remarks ? ` — ${remarks}` : ""}. Shift assignment ${appliedAssignmentId} created.`,
    reject: `Request rejected — ${remarks}`,
    withdraw: `Request withdrawn by ${actor.name}.`,
    cancel: `Request cancelled${remarks ? ` — ${remarks}` : ""}.${reversion === "reverted" ? " Future assignment reverted." : reversion === "kept" ? " Assignment already effective; not rewritten." : ""}`,
  }
  await logEvent({
    requestId,
    employeeId: Number(request.employee_id),
    type: action,
    message: messages[action],
    actorId: actor.userId,
    actorName: actor.name,
  })
  if (action === "approve" && appliedAssignmentId) {
    await logEvent({
      requestId,
      employeeId: Number(request.employee_id),
      type: "assignment_created",
      message: `Shift assignment ${appliedAssignmentId} effective ${String(request.from_date).slice(0, 10)}${request.to_date ? ` → ${String(request.to_date).slice(0, 10)}` : " onward"}.`,
      actorId: actor.userId,
      actorName: actor.name,
    })
  }

  // Notify the employee (best-effort).
  const employee = await getEmployeeFull(Number(request.employee_id))
  const employeeEmail = employee?.official_email || employee?.personal_email
  const requestedShift = await getShiftDetail(Number(request.requested_shift_id))
  const label: Record<RequestAction, string> = {
    approve: "approved",
    reject: "rejected",
    withdraw: "withdrawn",
    cancel: "cancelled",
  }
  if (action !== "withdraw") {
    await notifyByEmail(
      employeeEmail,
      `Your shift change request ${requestId} was ${label[action]}`,
      shell(
        "Shift change update",
        `<p>Your shift change to <strong>${requestedShift?.shift_name || "—"}</strong> (effective ${String(request.from_date).slice(0, 10)}${request.to_date ? ` → ${String(request.to_date).slice(0, 10)}` : " onward"}) was <strong>${label[action]}</strong>.</p>
         ${remarks ? `<p>Remarks: ${remarks}</p>` : ""}`,
      ),
    )
  }

  return { ok: true as const, status: request.status === action ? request.status : capitalize(label[action]), appliedAssignmentId }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Minimal email body wrapper (matches the leave module's plain shell). */
function shell(title: string, body: string) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">
    <h2 style="margin:0 0 12px">${title}</h2>${body}
    <p style="color:#888;font-size:12px;margin-top:16px">Muenot ERP — automated HR notification.</p>
  </div>`
}
