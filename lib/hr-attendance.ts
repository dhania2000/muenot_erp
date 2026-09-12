import { query } from "@/lib/db"
import { getSetting } from "@/lib/settings/server"

// ---------------------------------------------------------------------------
// HR Attendance — shared calculation & integration layer.
//
// This module is the single source of truth for attendance business logic so
// the clock-in/out route, the manual-entry API and reports all agree. It reads
// from existing masters (Employees, Shifts, Leaves, Holidays) and never
// duplicates that data — attendance rows only store the *derived* result.
// ---------------------------------------------------------------------------

export const DEFAULT_TIME_ZONE = "Asia/Kolkata"

/** Configured company timezone, falling back to IST (the ERP is India-based). */
export async function getTimeZone(): Promise<string> {
  return (await getSetting("app.timezone")) || DEFAULT_TIME_ZONE
}

/**
 * Wall-clock parts of `date` in the given IANA timezone. The server runs in UTC
 * on Vercel, so we project the instant into the company timezone rather than
 * read raw server-local fields (which would make stored punches hours off IST).
 */
export function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  const hour = get("hour") === "24" ? "00" : get("hour")
  return { y: get("year"), m: get("month"), d: get("day"), hh: hour, mm: get("minute"), ss: get("second") }
}

/** Local date as YYYY-MM-DD in the company timezone. */
export function todayInTz(timeZone: string) {
  const p = zonedParts(new Date(), timeZone)
  return `${p.y}-${p.m}-${p.d}`
}

/** MySQL DATETIME string (YYYY-MM-DD HH:MM:SS) in the company timezone. */
export function nowDateTimeInTz(timeZone: string) {
  const p = zonedParts(new Date(), timeZone)
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm}:${p.ss}`
}

/** Minutes since midnight for a HH:MM[:SS] string, or null if unparseable. */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const m = String(value).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** Minutes since midnight for the time portion of a DATETIME string. */
function dateTimeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const m = String(value).match(/\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return timeToMinutes(value)
  return Number(m[1]) * 60 + Number(m[2])
}

/** Hours between two DATETIME strings (never negative). */
export function hoursBetween(start: string, end: string): number {
  const value = (new Date(end.replace(" ", "T")).getTime() - new Date(start.replace(" ", "T")).getTime()) / 3600000
  return Math.max(0, value)
}

/** Human-friendly duration, e.g. 8.5 -> "8h 30m". Keeps the numeric value for maths. */
export function formatHoursHuman(hours: number | null | undefined): string {
  const h = Number(hours || 0)
  if (h <= 0) return "0h 0m"
  const totalMinutes = Math.round(h * 60)
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
}

/** Human-friendly minute count, e.g. 90 -> "1h 30m", 25 -> "25 min". */
export function formatMinutesHuman(minutes: number | null | undefined): string {
  const total = Math.round(Number(minutes || 0))
  if (total <= 0) return "0 min"
  if (total < 60) return `${total} min`
  return `${Math.floor(total / 60)}h ${total % 60}m`
}

// ---------------------------------------------------------------------------
// Schema — additive, idempotent. New databases get these via the migration
// file; existing databases get them lazily so a missed migration never breaks
// the feature. Every column is nullable / defaulted, so historical rows and
// the existing clock route keep working unchanged.
// ---------------------------------------------------------------------------
let schemaEnsured: Promise<void> | null = null
export function ensureAttendanceSchema(): Promise<void> {
  if (!schemaEnsured) schemaEnsured = doEnsureSchema()
  return schemaEnsured
}

async function addColumn(table: string, definition: string) {
  try {
    await query(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  } catch {
    // Column already exists (MySQL 8 lacks ADD COLUMN IF NOT EXISTS) — safe to ignore.
  }
}

async function doEnsureSchema() {
  // The attendance list joins a correlated subquery against this table for the
  // regularisation status column. On databases where its migration was never
  // applied the whole list query would throw (empty table + zero summary),
  // even though clock in/out — which never touches it — keeps working. Create
  // it lazily and idempotently so the list is resilient to a missed migration.
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS hr_attendance_regularisation (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        request_id VARCHAR(40) NOT NULL,
        attendance_id BIGINT UNSIGNED DEFAULT NULL,
        employee_id BIGINT UNSIGNED NOT NULL,
        employee_name VARCHAR(180) NOT NULL,
        work_date DATE NOT NULL,
        requested_clock_in DATETIME DEFAULT NULL,
        requested_clock_out DATETIME DEFAULT NULL,
        reason TEXT NOT NULL,
        attachment_path VARCHAR(500) DEFAULT NULL,
        status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
        requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_by VARCHAR(180) DEFAULT NULL,
        reviewed_at DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_hr_regularisation_request (request_id),
        KEY idx_hr_regularisation_status (status),
        KEY idx_hr_regularisation_employee (employee_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  } catch {
    // Best-effort: if creation fails, the list route's guard still degrades gracefully.
  }

  // Shift rule columns — drive late/early/overtime/weekly-off without hardcoding.
  await addColumn("hr_shifts", "`grace_minutes` INT UNSIGNED NOT NULL DEFAULT 10")
  await addColumn("hr_shifts", "`overtime_threshold_minutes` INT UNSIGNED NOT NULL DEFAULT 0")
  await addColumn("hr_shifts", "`is_overnight` TINYINT(1) NOT NULL DEFAULT 0")
  // Comma-separated weekday numbers (0=Sun .. 6=Sat) that are weekly offs.
  await addColumn("hr_shifts", "`weekly_offs` VARCHAR(30) DEFAULT NULL")

  // Attendance enrichment — status flags + audit/override + linkage columns.
  await addColumn("hr_attendance", "`flags` VARCHAR(255) DEFAULT NULL")
  await addColumn("hr_attendance", "`day_type` VARCHAR(30) DEFAULT NULL")
  await addColumn("hr_attendance", "`leave_request_id` VARCHAR(50) DEFAULT NULL")
  await addColumn("hr_attendance", "`is_manual_override` TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("hr_attendance", "`override_reason` VARCHAR(500) DEFAULT NULL")
  await addColumn("hr_attendance", "`created_by` INT UNSIGNED DEFAULT NULL")
  await addColumn("hr_attendance", "`updated_by` INT UNSIGNED DEFAULT NULL")

  // Helpful composite index for employee + date range scans.
  try {
    await query("ALTER TABLE hr_attendance ADD INDEX idx_hr_attendance_emp_date (employee_id, work_date)")
  } catch {
    // Index already present.
  }
}

// ---------------------------------------------------------------------------
// Masters lookup — read-only integration with existing modules.
// ---------------------------------------------------------------------------

export type EmployeeRecord = {
  id: number
  employee_id: string
  employee_name: string
  department: string | null
  designation: string | null
  reporting_manager: string | null
  employment_status: string | null
  joining_date: string | null
  exit_date: string | null
  archived_at: string | null
  shift: string | null
}

export type ShiftConfig = {
  id: number
  shift_id: string
  shift_name: string
  start_time: string
  end_time: string
  break_minutes: number
  working_hours: number
  overtime_enabled: boolean
  grace_minutes: number
  overtime_threshold_minutes: number
  is_overnight: boolean
  weekly_offs: number[]
  // Newer Shift Master policy fields. Defaulted so shifts created by the older
  // form (before these columns existed) keep the previous behaviour.
  late_enabled: boolean
  early_checkout_enabled: boolean
  early_grace_minutes: number
  overtime_eligible: boolean
  overtime_rounding_minutes: number
}

export async function getEmployeeById(id: number): Promise<EmployeeRecord | null> {
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, department, designation, reporting_manager,
            employment_status, joining_date, exit_date, archived_at, shift
     FROM hr_employees WHERE id = ? LIMIT 1`,
    [id],
  )
  return (rows[0] as EmployeeRecord) ?? null
}

/**
 * Deterministic rotation resolver. From the employee's active rotation
 * membership, count days since the membership start_date, take that modulo the
 * rotation's total cycle length (sum of sequence durations), then walk the
 * ordered sequences to find the shift covering that offset. Returns the Shift
 * Master db id, or null when the employee is not on an active rotation or it
 * cannot be resolved. Self-contained (only reads rotation tables) so the
 * central resolver has no cross-module import cycle.
 */
export async function resolveRotationShiftId(employeeId: number, onDate: string): Promise<number | null> {
  try {
    const memberRows = await query<any[]>(
      `SELECT re.start_date, r.id AS rotation_pk
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
      if (offset < dur) return Number(seq.shift_id)
      offset -= dur
    }
    return null
  } catch {
    return null
  }
}

/**
 * THE central "applicable shift" engine. Deterministic precedence (documented
 * in lib/hr-shift-assignments.ts and consumed by Attendance, Employee Profile,
 * Shift Assignments and Shift Change Requests — never duplicated):
 *   1. Active explicit assignment in hr_shift_assignments covering the date
 *      (latest effective_from wins). This includes assignments materialized
 *      from approved shift change requests, so an approved request always beats
 *      a rotation.
 *   2. Rotation-derived shift (active rotation membership).
 *   3. The free-text `shift` column on the employee, matched to hr_shifts
 *      (the company/default shift).
 * Returns null when nothing is configured so callers can flag "no shift".
 */
export async function resolveShiftForEmployee(
  employee: Pick<EmployeeRecord, "id" | "shift">,
  workDate: string,
): Promise<ShiftConfig | null> {
  // 1. Explicit assignment (Shift Assignments module — the authoritative layer).
  try {
    const assigned = await query<any[]>(
      `SELECT s.* FROM hr_shift_assignments a
       JOIN hr_shifts s ON s.id = a.shift_id
       WHERE a.employee_id = ? AND a.status = 'Active'
         AND a.effective_from <= ?
         AND (a.effective_to IS NULL OR a.effective_to >= ?)
       ORDER BY a.effective_from DESC LIMIT 1`,
      [employee.id, workDate, workDate],
    )
    if (assigned[0]) return normalizeShift(assigned[0])
  } catch {
    // Shift-assignments table may not exist on older databases — fall through.
  }

  // 2. Rotation-derived shift (active rotation membership).
  try {
    const rotationShiftId = await resolveRotationShiftId(employee.id, workDate)
    if (rotationShiftId) {
      const rotationShift = await query<any[]>(
        `SELECT * FROM hr_shifts WHERE id = ? AND (status = 'Active' OR status IS NULL) LIMIT 1`,
        [rotationShiftId],
      )
      if (rotationShift[0]) return normalizeShift(rotationShift[0])
    }
  } catch {
    // Rotation resolution is best-effort — fall through to the default shift.
  }

  // 3. Free-text shift on the employee master.
  if (employee.shift && employee.shift.trim()) {
    try {
      const matched = await query<any[]>(
        `SELECT * FROM hr_shifts WHERE (shift_name = ? OR shift_id = ?) AND status = 'Active' LIMIT 1`,
        [employee.shift.trim(), employee.shift.trim()],
      )
      if (matched[0]) return normalizeShift(matched[0])
    } catch {
      // hr_shifts missing — fall through.
    }
  }

  return null
}

function normalizeShift(row: any): ShiftConfig {
  const weekly = String(row.weekly_offs ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  const start = timeToMinutes(row.start_time) ?? 0
  const end = timeToMinutes(row.end_time) ?? 0
  return {
    id: Number(row.id),
    shift_id: row.shift_id,
    shift_name: row.shift_name,
    start_time: row.start_time,
    end_time: row.end_time,
    break_minutes: Number(row.break_minutes || 0),
    working_hours: Number(row.working_hours || 0),
    overtime_enabled: Boolean(row.overtime_enabled),
    grace_minutes: Number(row.grace_minutes ?? 10),
    overtime_threshold_minutes: Number(row.overtime_threshold_minutes ?? 0),
    // Treat as overnight when explicitly flagged or when end wraps past midnight.
    is_overnight: Boolean(row.is_overnight) || end < start,
    weekly_offs: weekly,
    // New policy fields default to the previous hard-coded behaviour when the
    // column is absent (older shifts): late & early tracking on, overtime
    // eligible, early grace mirrors the arrival grace, no OT rounding.
    late_enabled: row.late_enabled === undefined || row.late_enabled === null ? true : Boolean(Number(row.late_enabled)),
    early_checkout_enabled:
      row.early_checkout_enabled === undefined || row.early_checkout_enabled === null
        ? true
        : Boolean(Number(row.early_checkout_enabled)),
    early_grace_minutes: Number(row.early_grace_minutes ?? row.grace_minutes ?? 10),
    overtime_eligible:
      row.overtime_eligible === undefined || row.overtime_eligible === null ? true : Boolean(Number(row.overtime_eligible)),
    overtime_rounding_minutes: Number(row.overtime_rounding_minutes ?? 0),
  }
}

/** Approved leave covering the date, if any. Uses the existing Leaves module. */
export async function getApprovedLeaveForDate(
  employeeId: number,
  workDate: string,
): Promise<{ request_id: string; days: number; leave_type_id: string } | null> {
  try {
    const rows = await query<any[]>(
      `SELECT request_id, days, leave_type_id FROM hr_leave_requests
       WHERE employee_id = ? AND status = 'HR Approved'
         AND from_date <= ? AND to_date >= ? LIMIT 1`,
      [employeeId, workDate, workDate],
    )
    return rows[0] ?? null
  } catch {
    return null
  }
}

/** Public/company holiday on the date, if any. Uses HR Master Data holidays. */
export async function getHolidayForDate(
  workDate: string,
): Promise<{ holiday_name: string; holiday_type: string; optional: number } | null> {
  try {
    const rows = await query<any[]>(
      `SELECT holiday_name, holiday_type, optional FROM hr_holidays
       WHERE holiday_date = ? AND (status = 'Active' OR status IS NULL) LIMIT 1`,
      [workDate],
    )
    return rows[0] ?? null
  } catch {
    return null
  }
}

/** Whether the date is a weekly off for the shift (0=Sun..6=Sat). */
export function isWeeklyOff(shift: ShiftConfig | null, workDate: string): boolean {
  if (!shift || shift.weekly_offs.length === 0) return false
  // Parse as a plain date (no timezone shift) to get the weekday reliably.
  const [y, m, d] = workDate.split("-").map(Number)
  if (!y || !m || !d) return false
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return shift.weekly_offs.includes(weekday)
}

export type DayType = "Working" | "Holiday" | "Weekly Off" | "Leave"

export type DayContext = {
  dayType: DayType
  onLeave: boolean
  halfDayLeave: boolean
  leaveRequestId: string | null
  holidayName: string | null
  isWeeklyOff: boolean
}

/** Combine leave + holiday + weekly-off masters into the day's context. */
export async function resolveDayContext(
  employeeId: number,
  workDate: string,
  shift: ShiftConfig | null,
): Promise<DayContext> {
  const leave = await getApprovedLeaveForDate(employeeId, workDate)
  const holiday = await getHolidayForDate(workDate)
  const weeklyOff = isWeeklyOff(shift, workDate)

  const halfDayLeave = Boolean(leave && Number(leave.days) > 0 && Number(leave.days) < 1)
  let dayType: DayType = "Working"
  if (leave && !halfDayLeave) dayType = "Leave"
  else if (holiday) dayType = "Holiday"
  else if (weeklyOff) dayType = "Weekly Off"

  return {
    dayType,
    onLeave: Boolean(leave),
    halfDayLeave,
    leaveRequestId: leave?.request_id ?? null,
    holidayName: holiday?.holiday_name ?? null,
    isWeeklyOff: weeklyOff,
  }
}

// ---------------------------------------------------------------------------
// Core calculation — pure, no DB. Given punches + shift + day context, derive
// worked hours, late/early/overtime, status and exception flags.
// ---------------------------------------------------------------------------

export type AttendanceMetrics = {
  workingHours: number
  lateMinutes: number
  earlyLeavingMinutes: number
  overtimeHours: number
  status: string
  flags: string[]
}

export function computeAttendanceMetrics(opts: {
  shift: ShiftConfig | null
  clockIn: string | null
  clockOut: string | null
  breakMinutes?: number
  dayContext: DayContext
  /** Worked hours already accumulated (multi-session days). If omitted, derived from in/out. */
  workedHoursOverride?: number
  /** True while a session is still open (currently clocked in). */
  sessionOpen?: boolean
}): AttendanceMetrics {
  const { shift, clockIn, clockOut, dayContext } = opts
  const flags: string[] = []

  // 1) Non-working day with no punch → reflect the calendar/leave master.
  if (!clockIn) {
    if (dayContext.dayType === "Leave") return blank("On Leave", flags)
    if (dayContext.dayType === "Holiday") return blank("Holiday", flags)
    if (dayContext.dayType === "Weekly Off") return blank("Weekly Off", flags)
    return blank("Absent", flags)
  }

  // 2) Clocked in but still open (today) or never clocked out (missed checkout).
  const missedCheckout = Boolean(clockIn) && !clockOut && !opts.sessionOpen

  // Worked hours: prefer the accumulated value (sessions/breaks handled upstream).
  let workingHours = 0
  if (typeof opts.workedHoursOverride === "number") {
    workingHours = Math.max(0, opts.workedHoursOverride)
  } else if (clockIn && clockOut) {
    const gross = hoursBetween(clockIn, clockOut)
    workingHours = Math.max(0, gross - Number(opts.breakMinutes || 0) / 60)
  }
  workingHours = Number(workingHours.toFixed(2))

  // 3) Shift-driven late / early / overtime.
  let lateMinutes = 0
  let earlyLeavingMinutes = 0
  let overtimeHours = 0

  if (shift) {
    const grace = shift.grace_minutes
    const startMin = timeToMinutes(shift.start_time) ?? 0
    let endMin = timeToMinutes(shift.end_time) ?? 0
    if (shift.is_overnight && endMin <= startMin) endMin += 24 * 60

    const inMin = dateTimeToMinutes(clockIn)
    // Late tracking is a per-shift policy toggle now — respect it.
    if (shift.late_enabled && inMin !== null) {
      const late = inMin - startMin - grace
      if (late > 0) {
        lateMinutes = late
        flags.push("Late")
      }
    }

    if (clockOut) {
      let outMin = dateTimeToMinutes(clockOut) ?? 0
      // Overnight clock-out after midnight lands in the next calendar day.
      if (shift.is_overnight && outMin < startMin) outMin += 24 * 60
      // Early-out uses its own grace window and can be disabled per shift.
      if (shift.early_checkout_enabled) {
        const early = endMin - outMin - shift.early_grace_minutes
        if (early > 0) {
          earlyLeavingMinutes = early
          flags.push("Early Out")
        }
      }
      // Overtime requires both the shift and this specific shift being eligible;
      // the surplus past the threshold is rounded to the configured increment.
      if (shift.overtime_enabled && shift.overtime_eligible) {
        const overtimeMin = outMin - endMin - shift.overtime_threshold_minutes
        if (overtimeMin > 0) {
          const rounded = roundOvertime(overtimeMin, shift.overtime_rounding_minutes)
          if (rounded > 0) {
            overtimeHours = Number((rounded / 60).toFixed(2))
            flags.push("Overtime")
          }
        }
      }
    }
  }

  // 4) Status engine. Status stays a single value; exceptions live in flags.
  let status: string
  if (missedCheckout) {
    status = "Missed Checkout"
  } else if (dayContext.dayType === "Holiday") {
    status = "Holiday Worked"
    flags.push("Holiday Worked")
  } else if (dayContext.dayType === "Weekly Off") {
    status = "Weekly Off Worked"
  } else if (dayContext.halfDayLeave) {
    status = "Half Day"
  } else {
    const expected = shift?.working_hours || 0
    if (clockOut && expected > 0 && workingHours > 0 && workingHours < expected / 2) {
      status = "Half Day"
    } else {
      status = "Present"
    }
  }

  return { workingHours, lateMinutes, earlyLeavingMinutes, overtimeHours, status, flags: dedupe(flags) }
}

function blank(status: string, flags: string[]): AttendanceMetrics {
  return { workingHours: 0, lateMinutes: 0, earlyLeavingMinutes: 0, overtimeHours: 0, status, flags: dedupe(flags) }
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list))
}

/**
 * Round overtime minutes down to the configured increment (0/15/30/60). We
 * round *down* so an employee is only credited overtime for a full completed
 * increment. Zero (or an unset increment) means no rounding.
 */
function roundOvertime(minutes: number, increment: number): number {
  if (!increment || increment <= 0) return Math.max(0, Math.round(minutes))
  return Math.floor(minutes / increment) * increment
}

/**
 * Shift-aware work date. For overnight shifts, a punch in the early hours
 * belongs to the *previous* calendar day's shift. Day shifts are unaffected so
 * existing behaviour is preserved.
 */
export function resolveWorkDate(shift: ShiftConfig | null, timeZone: string): string {
  const today = todayInTz(timeZone)
  if (!shift || !shift.is_overnight) return today

  const p = zonedParts(new Date(), timeZone)
  const nowMin = Number(p.hh) * 60 + Number(p.mm)
  const endMin = timeToMinutes(shift.end_time) ?? 0
  const startMin = timeToMinutes(shift.start_time) ?? 0
  // Before the (wrapped) end time and before the start time → still yesterday's shift.
  if (nowMin < endMin && nowMin < startMin) {
    const [y, m, d] = today.split("-").map(Number)
    const prev = new Date(Date.UTC(y, m - 1, d - 1))
    return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(
      prev.getUTCDate(),
    ).padStart(2, "0")}`
  }
  return today
}

/** Whether an employee may clock in on the given date per lifecycle rules. */
export function clockInEligibility(
  employee: EmployeeRecord,
  workDate: string,
): { allowed: boolean; reason?: string } {
  const status = (employee.employment_status || "").toLowerCase()
  if (employee.archived_at) return { allowed: false, reason: "Employee is archived." }
  if (["terminated", "resigned", "ex-employee", "inactive"].some((s) => status.includes(s))) {
    return { allowed: false, reason: `Employee status is ${employee.employment_status}.` }
  }
  if (employee.exit_date && workDate > String(employee.exit_date).slice(0, 10)) {
    return { allowed: false, reason: "Employee has exited the organisation." }
  }
  if (employee.joining_date && workDate < String(employee.joining_date).slice(0, 10)) {
    return { allowed: false, reason: "Date is before the employee's joining date." }
  }
  return { allowed: true }
}
