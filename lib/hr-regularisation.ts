import { pool, query } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { nextRecordId } from "@/lib/record-ids"
import { logEmployeeEvent } from "@/lib/hr-employee-events"
import {
  ensureAttendanceSchema,
  getEmployeeById,
  resolveShiftForEmployee,
  resolveDayContext,
  computeAttendanceMetrics,
  getTimeZone,
  type EmployeeRecord,
  type ShiftConfig,
  type DayContext,
} from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Attendance Regularisation — request + approval workflow that proposes changes
// to the central Attendance record. This module never re-implements attendance
// maths; on approval it feeds the requested punches back through the shared
// calculation engine in lib/hr-attendance.ts and writes the derived result to
// the real hr_attendance row inside a transaction, with a before/after audit.
// ---------------------------------------------------------------------------

export const REG_STATUSES = ["Pending", "Approved", "Rejected", "Cancelled"] as const
export type RegStatus = (typeof REG_STATUSES)[number]

export const CORRECTION_TYPES = [
  "Missing Clock In",
  "Missing Clock Out",
  "Incorrect Clock In",
  "Incorrect Clock Out",
  "Incorrect Status",
  "Missing Attendance",
  "Other Correction",
] as const

export const REASON_PRESETS = [
  "Forgot to clock in",
  "Forgot to clock out",
  "Biometric machine unavailable",
  "Internet / network issue",
  "Field visit",
  "Official work outside office",
  "Other",
] as const

/** Feature slug that grants approver / all-employees access. */
export const MANAGE_FEATURE = "hr.manage_regularisation"

// ---------------------------------------------------------------------------
// Schema — additive & idempotent. New databases get the base table from the
// migration; existing databases get the workflow columns lazily so a missed
// migration never breaks the feature. All new columns are nullable.
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null
export function ensureRegularisationSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  // Guarantees the base hr_attendance_regularisation + hr_attendance tables.
  await ensureAttendanceSchema()

  // Widen status so it can hold the full lifecycle (base migration used an ENUM
  // without 'Cancelled'). VARCHAR keeps future statuses cheap to add.
  try {
    await query("ALTER TABLE hr_attendance_regularisation MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'Pending'")
  } catch {
    // Already widened / insufficient privilege — the app still functions.
  }

  const columns = [
    "correction_type VARCHAR(50) DEFAULT NULL",
    "current_clock_in DATETIME DEFAULT NULL",
    "current_clock_out DATETIME DEFAULT NULL",
    "current_status VARCHAR(50) DEFAULT NULL",
    "requested_status VARCHAR(50) DEFAULT NULL",
    "department VARCHAR(180) DEFAULT NULL",
    "designation VARCHAR(180) DEFAULT NULL",
    "reporting_manager VARCHAR(180) DEFAULT NULL",
    "requested_by INT UNSIGNED DEFAULT NULL",
    "requested_by_name VARCHAR(180) DEFAULT NULL",
    "rejection_reason TEXT DEFAULT NULL",
    "applied_at DATETIME DEFAULT NULL",
    "attachment_name VARCHAR(255) DEFAULT NULL",
  ]
  for (const definition of columns) {
    try {
      await query(`ALTER TABLE hr_attendance_regularisation ADD COLUMN ${definition}`)
    } catch {
      // Column already present (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
    }
  }

  try {
    await query("ALTER TABLE hr_attendance_regularisation ADD INDEX idx_reg_emp_date (employee_id, work_date)")
  } catch {
    // Index already present.
  }
}

// ---------------------------------------------------------------------------
// Access + identity helpers.
// ---------------------------------------------------------------------------

/** True when the session may approve requests and see every employee's data. */
export async function canManageRegularisation(session: SessionPayload): Promise<boolean> {
  return userHasFeature(session.userId, session.role, MANAGE_FEATURE)
}

/** The employee record linked to the session by email, or null if unmapped. */
export async function resolveSessionEmployee(session: SessionPayload): Promise<EmployeeRecord | null> {
  const rows = await query<{ id: number }[]>(
    "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [session.email, session.email],
  )
  if (!rows[0]) return null
  return getEmployeeById(Number(rows[0].id))
}

// ---------------------------------------------------------------------------
// Attendance context — source of truth read from the central module.
// ---------------------------------------------------------------------------

export type AttendanceSnapshot = {
  id: number
  attendance_id: string
  clock_in: string | null
  clock_out: string | null
  status: string
  working_hours: number
} | null

export async function getAttendanceForDate(employeeId: number, workDate: string): Promise<AttendanceSnapshot> {
  const rows = await query<any[]>(
    "SELECT id, attendance_id, clock_in, clock_out, status, working_hours FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
    [employeeId, workDate],
  )
  return (rows[0] as AttendanceSnapshot) ?? null
}

export type DayInsight = {
  employee: EmployeeRecord
  shift: ShiftConfig | null
  dayContext: DayContext
  attendance: AttendanceSnapshot
  suggestedType: string
  /** Whether a Pending request already exists for this employee + date. */
  pendingExists: boolean
  /** Blocking condition (approved full-day leave) unless the actor may manage. */
  blocked: { reason: string } | null
}

/** Suggest the correction type from the existing attendance shape. */
export function suggestCorrectionType(attendance: AttendanceSnapshot): string {
  if (!attendance) return "Missing Attendance"
  if (attendance.clock_in && !attendance.clock_out) return "Missing Clock Out"
  if (!attendance.clock_in && attendance.clock_out) return "Missing Clock In"
  return "Other Correction"
}

/** Everything the form needs to show current-vs-requested and warn safely. */
export async function buildDayInsight(employee: EmployeeRecord, workDate: string): Promise<DayInsight> {
  const shift = await resolveShiftForEmployee(employee, workDate)
  const dayContext = await resolveDayContext(employee.id, workDate, shift)
  const attendance = await getAttendanceForDate(employee.id, workDate)

  const pending = await query<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM hr_attendance_regularisation WHERE employee_id = ? AND work_date = ? AND status = 'Pending'",
    [employee.id, workDate],
  )
  const pendingExists = Number(pending[0]?.c || 0) > 0

  let blocked: { reason: string } | null = null
  if (dayContext.onLeave && !dayContext.halfDayLeave) {
    blocked = { reason: "Employee is on approved full-day leave for this date." }
  }

  return {
    employee,
    shift,
    dayContext,
    attendance,
    suggestedType: suggestCorrectionType(attendance),
    pendingExists,
    blocked,
  }
}

// ---------------------------------------------------------------------------
// Date/time normalisation.
// ---------------------------------------------------------------------------

/** Coerce a form value to a MySQL DATETIME anchored on the work date. */
export function toDateTime(workDate: string, value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return text.replace("T", " ").slice(0, 19).padEnd(19, ":00").slice(0, 19)
  if (/^\d{1,2}:\d{2}/.test(text)) {
    const t = text.length === 4 ? `0${text}` : text
    return `${workDate} ${t}:00`.slice(0, 19)
  }
  return text
}

// ---------------------------------------------------------------------------
// Approval → attendance update, transactionally, with before/after audit.
// ---------------------------------------------------------------------------

export type ApplyResult = {
  attendanceId: string
  created: boolean
  status: string
  changes: { field: string; label: string; from: unknown; to: unknown }[]
}

/**
 * Approve a pending request and apply it to the real attendance record inside a
 * single transaction. The requested punches are run back through the shared
 * calculation engine so hours/late/early/overtime/status stay consistent with
 * the rest of the ERP. Returns the applied changes for auditing.
 */
export async function approveAndApply(requestRow: any, reviewer: SessionPayload): Promise<ApplyResult> {
  const workDate = String(requestRow.work_date).slice(0, 10)
  const employee = await getEmployeeById(Number(requestRow.employee_id))
  if (!employee) throw new Error("Linked employee no longer exists.")

  // Reads outside the transaction are fine — masters are immutable here.
  const shift = await resolveShiftForEmployee(employee, workDate)
  const dayContext = await resolveDayContext(employee.id, workDate, shift)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [attRows] = await conn.query<any[]>(
      "SELECT * FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1 FOR UPDATE",
      [employee.id, workDate],
    )
    const existing = attRows[0]

    const newClockIn =
      requestRow.requested_clock_in ?? existing?.clock_in ?? null
    const newClockOut =
      requestRow.requested_clock_out ?? existing?.clock_out ?? null
    const breakMinutes = Number(existing?.break_minutes || 0)

    const metrics = computeAttendanceMetrics({
      shift,
      clockIn: newClockIn,
      clockOut: newClockOut,
      breakMinutes,
      dayContext,
    })
    const finalStatus = requestRow.requested_status ? String(requestRow.requested_status) : metrics.status

    const changes: ApplyResult["changes"] = []
    const track = (field: string, label: string, before: unknown, after: unknown) => {
      if (String(before ?? "") !== String(after ?? "")) changes.push({ field, label, from: before ?? null, to: after ?? null })
    }

    let attendanceId: string
    let created = false

    if (existing) {
      attendanceId = existing.attendance_id
      track("clock_in", "Clock in", existing.clock_in, newClockIn)
      track("clock_out", "Clock out", existing.clock_out, newClockOut)
      track("status", "Status", existing.status, finalStatus)

      await conn.query(
        `UPDATE hr_attendance SET clock_in = ?, clock_out = ?, working_hours = ?, status = ?,
           late_minutes = ?, early_leaving_minutes = ?, overtime_hours = ?, flags = ?, day_type = ?,
           is_manual_override = 1, override_reason = ?, updated_by = ? WHERE id = ?`,
        [
          newClockIn,
          newClockOut,
          metrics.workingHours,
          finalStatus,
          metrics.lateMinutes,
          metrics.earlyLeavingMinutes,
          metrics.overtimeHours,
          metrics.flags.join(","),
          dayContext.dayType,
          `Regularisation ${requestRow.request_id}`.slice(0, 500),
          reviewer.userId,
          existing.id,
        ],
      )
    } else {
      // Missing-attendance correction: create the record the approval authorises.
      created = true
      attendanceId = await nextRecordId("ATT", { allowCustom: true, digits: 6 })
      track("clock_in", "Clock in", null, newClockIn)
      track("clock_out", "Clock out", null, newClockOut)
      track("status", "Status", null, finalStatus)

      await conn.query(
        `INSERT INTO hr_attendance
           (attendance_id, employee_id, employee_name, work_date, clock_in, clock_out, break_minutes,
            working_hours, status, late_minutes, early_leaving_minutes, overtime_hours, source,
            flags, day_type, leave_request_id, is_manual_override, override_reason, created_by, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          attendanceId,
          employee.id,
          employee.employee_name,
          workDate,
          newClockIn,
          newClockOut,
          breakMinutes,
          metrics.workingHours,
          finalStatus,
          metrics.lateMinutes,
          metrics.earlyLeavingMinutes,
          metrics.overtimeHours,
          "Regularisation",
          metrics.flags.join(","),
          dayContext.dayType,
          dayContext.leaveRequestId,
          1,
          `Regularisation ${requestRow.request_id}`.slice(0, 500),
          reviewer.userId,
          reviewer.userId,
        ],
      )
      const [idRow] = await conn.query<any[]>(
        "SELECT id FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
        [employee.id, workDate],
      )
      if (idRow[0]) requestRow.attendance_id = idRow[0].id
    }

    await conn.query(
      `UPDATE hr_attendance_regularisation
         SET status = 'Approved', reviewed_by = ?, reviewed_at = NOW(), applied_at = NOW(),
             attendance_id = COALESCE(attendance_id, ?)
       WHERE id = ?`,
      [reviewer.name, requestRow.attendance_id || null, requestRow.id],
    )

    await conn.commit()

    // Audit outside the transaction so a logging hiccup can't roll back the apply.
    await logEmployeeEvent({
      employeeId: employee.id,
      employeeRef: employee.employee_id,
      employeeName: employee.employee_name,
      type: "updated",
      summary: `Regularisation ${requestRow.request_id} approved by ${reviewer.name} — attendance ${attendanceId} ${created ? "created" : "updated"} for ${workDate}`,
      changes: changes.length ? changes : null,
      actorId: reviewer.userId,
      actorName: reviewer.name,
    })

    return { attendanceId, created, status: finalStatus, changes }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export { getTimeZone }
