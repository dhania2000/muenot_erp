import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession, type SessionPayload } from "@/lib/auth"
import { getSetting } from "@/lib/settings/server"
import {
  ensureAttendanceSchema,
  getEmployeeById,
  resolveShiftForEmployee,
  resolveDayContext,
  computeAttendanceMetrics,
  clockInEligibility,
  type AttendanceMetrics,
  type DayContext,
} from "@/lib/hr-attendance"

const DEFAULT_TIME_ZONE = "Asia/Kolkata"

/** Configured company timezone, falling back to IST. */
async function getTimeZone(): Promise<string> {
  return (await getSetting("app.timezone")) || DEFAULT_TIME_ZONE
}

/**
 * Whether the attendance calculation columns (flags/day_type/etc.) are present.
 * ensureAttendanceSchema() adds them lazily; we detect once so enrichment is
 * skipped gracefully on databases where the ALTER could not be applied.
 */
let calcColumnsReady: boolean | null = null
async function hasCalcColumns(): Promise<boolean> {
  if (calcColumnsReady !== null) return calcColumnsReady
  try {
    await ensureAttendanceSchema()
    const rows = await query<{ Field: string }[]>("SHOW COLUMNS FROM hr_attendance LIKE 'flags'")
    calcColumnsReady = rows.length > 0
  } catch {
    calcColumnsReady = false
  }
  return calcColumnsReady
}

/** Resolve shift + day context (leave/holiday/weekly-off) for enrichment. */
async function loadDayContext(employeeId: number, workDate: string) {
  const employee = await getEmployeeById(employeeId)
  const shift = employee ? await resolveShiftForEmployee(employee, workDate) : null
  const dayContext = await resolveDayContext(employeeId, workDate, shift)
  return { employee, shift, dayContext }
}

/** SET fragments + params applying computed metrics to the calc columns. */
function enrichmentSets(metrics: AttendanceMetrics, dayContext: DayContext): { sets: string[]; params: unknown[] } {
  return {
    sets: [
      "status = ?",
      "late_minutes = ?",
      "early_leaving_minutes = ?",
      "overtime_hours = ?",
      "flags = ?",
      "day_type = ?",
      "leave_request_id = COALESCE(?, leave_request_id)",
    ],
    params: [
      metrics.status,
      metrics.lateMinutes,
      metrics.earlyLeavingMinutes,
      metrics.overtimeHours,
      metrics.flags.join(","),
      dayContext.dayType,
      dayContext.leaveRequestId,
    ],
  }
}

type EmployeeRow = { id: number; employee_name: string }
type AttendanceRow = {
  id: number
  clock_in: string | null
  clock_out: string | null
  break_minutes: number
  working_hours: number
  active_since: string | null
  work_date: string
}

/**
 * Wall-clock parts of `date` in the given IANA timezone. The server runs in UTC
 * on Vercel, so we must project the instant into the company timezone rather
 * than read the raw server-local fields (which caused stored punches to be
 * ~5.5h behind IST).
 */
function zonedParts(date: Date, timeZone: string) {
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

/** Local date as YYYY-MM-DD in the company timezone so a work day matches the user's day. */
function today(timeZone: string) {
  const p = zonedParts(new Date(), timeZone)
  return `${p.y}-${p.m}-${p.d}`
}

/** MySQL DATETIME string (YYYY-MM-DD HH:MM:SS) in the company timezone. */
function nowDateTime(timeZone: string) {
  const p = zonedParts(new Date(), timeZone)
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm}:${p.ss}`
}

/** Hours between two DATETIME strings (never negative). */
function hoursBetween(start: string, end: string) {
  const value = (new Date(end).getTime() - new Date(start).getTime()) / 3600000
  return Math.max(0, value)
}

async function resolveEmployee(email: string): Promise<EmployeeRow | null> {
  const rows = await query<EmployeeRow[]>(
    "SELECT id, employee_name FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [email, email],
  )
  return rows[0] ?? null
}

/**
 * Return the employee linked to the session, creating a minimal profile the
 * first time if none exists. Every logged-in user can clock in without an HR
 * admin pre-creating their record. Idempotent: existing users are reused, and
 * a duplicate-insert race falls back to a re-lookup.
 */
async function ensureEmployee(session: SessionPayload): Promise<EmployeeRow> {
  const existing = await resolveEmployee(session.email)
  if (existing) return existing

  const employeeCode = `EMP-U${session.userId}`
  const employeeName = session.name?.trim() || session.email

  try {
    await query(
      "INSERT INTO hr_employees (employee_id, employee_name, official_email, employment_status, onboarding_status, created_by) VALUES (?, ?, ?, 'Active', 'Self-registered', ?)",
      [employeeCode, employeeName, session.email, session.userId],
    )
  } catch {
    // Unique-key race (another request created it first) — fall through to re-lookup.
  }

  const created = await resolveEmployee(session.email)
  if (created) return created

  // Extremely rare: employee_id collided but email didn't match. Look up by code.
  const byCode = await query<EmployeeRow[]>(
    "SELECT id, employee_name FROM hr_employees WHERE employee_id = ? LIMIT 1",
    [employeeCode],
  )
  if (byCode[0]) return byCode[0]
  throw new Error("Could not create or find your employee profile.")
}

/**
 * Ensure the hr_attendance table exists before any read/write. On databases
 * where the SQL migration was never applied the table is missing, which would
 * otherwise make every punch fail. We create it once per server process with
 * the full schema (including `active_since` for multi-session days). Best-effort:
 * if creation fails, the caller's own query will surface the real error.
 */
let tableEnsured = false
async function ensureTable(): Promise<void> {
  if (tableEnsured) return
  await query(`
    CREATE TABLE IF NOT EXISTS hr_attendance (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      attendance_id VARCHAR(40) NOT NULL,
      employee_id BIGINT UNSIGNED NOT NULL,
      employee_name VARCHAR(180) NOT NULL,
      work_date DATE NOT NULL,
      clock_in DATETIME DEFAULT NULL,
      clock_out DATETIME DEFAULT NULL,
      active_since DATETIME DEFAULT NULL,
      break_minutes INT UNSIGNED NOT NULL DEFAULT 0,
      working_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      status VARCHAR(40) NOT NULL DEFAULT 'Present',
      late_minutes INT UNSIGNED NOT NULL DEFAULT 0,
      early_leaving_minutes INT UNSIGNED NOT NULL DEFAULT 0,
      overtime_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      location VARCHAR(180) DEFAULT NULL,
      latitude DECIMAL(10,7) DEFAULT NULL,
      longitude DECIMAL(10,7) DEFAULT NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'Manual',
      regularisation_required TINYINT(1) NOT NULL DEFAULT 0,
      remarks TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_hr_attendance_employee_date (employee_id, work_date),
      KEY idx_hr_attendance_date (work_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  tableEnsured = true
}

/**
 * Whether the hr_attendance table has the geolocation columns. Older databases
 * created before the location feature won't have them, so we detect once and
 * cache the result to avoid writing to columns that don't exist.
 */
let locationColumnsExist: boolean | null = null
async function hasLocationColumns(): Promise<boolean> {
  if (locationColumnsExist !== null) return locationColumnsExist
  try {
    const rows = await query<{ Field: string }[]>("SHOW COLUMNS FROM hr_attendance LIKE 'latitude'")
    locationColumnsExist = rows.length > 0
  } catch {
    locationColumnsExist = false
  }
  return locationColumnsExist
}

/**
 * Whether the `active_since` column is usable. It records the start of the
 * current open work session so a single day can hold several clock-in /
 * clock-out cycles in one row. We try to create it once; if that fails (e.g.
 * insufficient privileges) we fall back to a `clock_out IS NULL` based scheme
 * so clocking in/out still works without the column.
 */
let sessionColumnReady: boolean | null = null
async function hasSessionColumn(): Promise<boolean> {
  if (sessionColumnReady !== null) return sessionColumnReady
  try {
    const rows = await query<{ Field: string }[]>("SHOW COLUMNS FROM hr_attendance LIKE 'active_since'")
    if (rows.length === 0) {
      try {
        await query("ALTER TABLE hr_attendance ADD COLUMN active_since DATETIME NULL DEFAULT NULL")
        sessionColumnReady = true
      } catch {
        sessionColumnReady = false
      }
    } else {
      sessionColumnReady = true
    }
  } catch {
    sessionColumnReady = false
  }
  return sessionColumnReady
}

async function todaysRecord(employeeId: number, withSession: boolean, timeZone: string): Promise<AttendanceRow | null> {
  const columns = withSession
    ? "id, clock_in, clock_out, break_minutes, working_hours, active_since, work_date"
    : "id, clock_in, clock_out, break_minutes, working_hours, work_date"
  const rows = await query<AttendanceRow[]>(
    `SELECT ${columns} FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1`,
    [employeeId, today(timeZone)],
  )
  const row = rows[0]
  if (!row) return null
  if (!withSession) row.active_since = null
  return row
}

/**
 * A record represents an open session (currently clocked in) when `active_since`
 * is set, or — without that column — when there is a clock_in but no clock_out.
 */
function isOpen(record: AttendanceRow | null, withSession: boolean): boolean {
  if (!record) return false
  if (withSession) return Boolean(record.active_since)
  return Boolean(record.clock_in) && !record.clock_out
}

/** Start of the currently open session, used to compute this session's hours. */
function sessionStart(record: AttendanceRow, withSession: boolean, timeZone: string): string {
  if (withSession) return record.active_since || record.clock_in || nowDateTime(timeZone)
  return record.clock_in || nowDateTime(timeZone)
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureTable()
    const withSession = await hasSessionColumn()
    const timeZone = await getTimeZone()
    const employee = await ensureEmployee(session)

    const record = await todaysRecord(employee.id, withSession, timeZone)
    return NextResponse.json({
      linked: true,
      state: isOpen(record, withSession) ? "in" : "out",
      clockIn: record?.clock_in ?? null,
      clockOut: record?.clock_out ?? null,
      workedHours: record ? Number(record.working_hours || 0) : 0,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load status" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureTable()
    const withSession = await hasSessionColumn()
    const timeZone = await getTimeZone()
    const employee = await ensureEmployee(session)

    // Optional geolocation captured by the browser at punch time.
    let body: { latitude?: unknown; longitude?: unknown; location?: unknown } = {}
    try {
      body = await request.json()
    } catch {
      // No body (or invalid JSON) — location capture is optional.
    }
    const latitude = typeof body.latitude === "number" && Number.isFinite(body.latitude) ? body.latitude : null
    const longitude = typeof body.longitude === "number" && Number.isFinite(body.longitude) ? body.longitude : null
    const location =
      typeof body.location === "string" && body.location.trim() ? body.location.trim().slice(0, 255) : null

    // Location is mandatory: refuse to record any punch without valid coordinates.
    if (
      latitude === null ||
      longitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return NextResponse.json(
        { error: "Location is required to clock in or out. Please enable location access and try again." },
        { status: 400 },
      )
    }

    const record = await todaysRecord(employee.id, withSession, timeZone)
    const now = nowDateTime(timeZone)
    const withLocation = await hasLocationColumns()

    const workDate = today(timeZone)
    const withCalc = await hasCalcColumns()

    // First punch of the day → create the row and open a session (clock in).
    if (!record) {
      // Enforce lifecycle + full-day leave rules before opening a session.
      const { employee: full, shift, dayContext } = await loadDayContext(employee.id, workDate)
      if (full) {
        const eligibility = clockInEligibility(full, workDate)
        if (!eligibility.allowed) {
          return NextResponse.json({ error: eligibility.reason || "You cannot clock in today." }, { status: 400 })
        }
      }
      if (dayContext.onLeave && !dayContext.halfDayLeave) {
        return NextResponse.json({ error: "You are on approved leave today and cannot clock in." }, { status: 400 })
      }
      const metrics = computeAttendanceMetrics({ shift, clockIn: now, clockOut: null, dayContext, sessionOpen: true })

      const attendanceId = `ATT-${employee.id}-${workDate.replace(/-/g, "")}`
      const cols = ["attendance_id", "employee_id", "employee_name", "work_date", "clock_in", "status", "source"]
      const vals: unknown[] = [attendanceId, employee.id, employee.employee_name, workDate, now, metrics.status, "Portal"]
      if (withSession) {
        cols.splice(5, 0, "active_since")
        vals.splice(5, 0, now)
      }
      if (withLocation) {
        cols.push("location", "latitude", "longitude")
        vals.push(location, latitude, longitude)
      }
      if (withCalc) {
        cols.push("late_minutes", "flags", "day_type", "leave_request_id")
        vals.push(metrics.lateMinutes, metrics.flags.join(","), dayContext.dayType, dayContext.leaveRequestId)
      }
      await query(
        `INSERT INTO hr_attendance (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        vals,
      )
      return NextResponse.json({ ok: true, state: "in", clockIn: now, clockOut: null, status: metrics.status })
    }

    // Currently in an open session → clock out, accumulate worked hours, and
    // recompute the break total as the day's span minus worked time.
    if (isOpen(record, withSession)) {
      const firstIn = record.clock_in || sessionStart(record, withSession, timeZone)
      const sessionHours = hoursBetween(sessionStart(record, withSession, timeZone), now)
      const worked = Number((Number(record.working_hours || 0) + sessionHours).toFixed(2))
      const spanMinutes = hoursBetween(firstIn, now) * 60
      const breakMinutes = Math.max(0, Math.round(spanMinutes - worked * 60))

      const sets = ["clock_out = ?", "working_hours = ?", "break_minutes = ?"]
      const params: unknown[] = [now, worked, breakMinutes]
      if (withSession) sets.push("active_since = NULL")
      if (withLocation) {
        sets.push("location = COALESCE(?, location)", "latitude = COALESCE(?, latitude)", "longitude = COALESCE(?, longitude)")
        params.push(location, latitude, longitude)
      }
      if (withCalc) {
        const { shift, dayContext } = await loadDayContext(employee.id, workDate)
        const metrics = computeAttendanceMetrics({
          shift,
          clockIn: firstIn,
          clockOut: now,
          dayContext,
          workedHoursOverride: worked,
          sessionOpen: false,
        })
        const enrich = enrichmentSets(metrics, dayContext)
        sets.push(...enrich.sets)
        params.push(...enrich.params)
      }
      params.push(record.id)
      await query(`UPDATE hr_attendance SET ${sets.join(", ")} WHERE id = ?`, params)
      return NextResponse.json({ ok: true, state: "out", clockIn: firstIn, clockOut: now, workedHours: worked })
    }

    // Row exists but no open session → start a new session (clock in again).
    // Keep the day's first clock_in; clear the visible clock_out while working.
    const firstIn = withSession ? record.clock_in || now : now
    const sets = ["clock_out = NULL", "source = 'Portal'"]
    const params: unknown[] = []
    if (withSession) {
      sets.unshift("clock_in = ?", "active_since = ?")
      params.push(firstIn, now)
    } else {
      sets.unshift("clock_in = ?")
      params.push(now)
    }
    if (withLocation) {
      sets.push("location = COALESCE(?, location)", "latitude = COALESCE(?, latitude)", "longitude = COALESCE(?, longitude)")
      params.push(location, latitude, longitude)
    }
    if (withCalc) {
      const { shift, dayContext } = await loadDayContext(employee.id, workDate)
      const metrics = computeAttendanceMetrics({ shift, clockIn: firstIn, clockOut: null, dayContext, sessionOpen: true })
      sets.push("status = ?", "late_minutes = ?", "flags = ?", "day_type = ?")
      params.push(metrics.status, metrics.lateMinutes, metrics.flags.join(","), dayContext.dayType)
    }
    params.push(record.id)
    await query(`UPDATE hr_attendance SET ${sets.join(", ")} WHERE id = ?`, params)
    return NextResponse.json({ ok: true, state: "in", clockIn: firstIn, clockOut: null })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update attendance" }, { status: 500 })
  }
}
