import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession, type SessionPayload } from "@/lib/auth"

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

/** Local date as YYYY-MM-DD (server timezone) so a work day matches the user's day. */
function today() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** MySQL DATETIME string (YYYY-MM-DD HH:MM:SS) in server local time. */
function nowDateTime() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
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

async function todaysRecord(employeeId: number, withSession: boolean): Promise<AttendanceRow | null> {
  const columns = withSession
    ? "id, clock_in, clock_out, break_minutes, working_hours, active_since, work_date"
    : "id, clock_in, clock_out, break_minutes, working_hours, work_date"
  const rows = await query<AttendanceRow[]>(
    `SELECT ${columns} FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1`,
    [employeeId, today()],
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
function sessionStart(record: AttendanceRow, withSession: boolean): string {
  if (withSession) return record.active_since || record.clock_in || nowDateTime()
  return record.clock_in || nowDateTime()
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const withSession = await hasSessionColumn()
    const employee = await ensureEmployee(session)

    const record = await todaysRecord(employee.id, withSession)
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

    const withSession = await hasSessionColumn()
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

    const record = await todaysRecord(employee.id, withSession)
    const now = nowDateTime()
    const withLocation = await hasLocationColumns()

    // First punch of the day → create the row and open a session (clock in).
    if (!record) {
      const attendanceId = `ATT-${employee.id}-${today().replace(/-/g, "")}`
      const cols = ["attendance_id", "employee_id", "employee_name", "work_date", "clock_in", "status", "source"]
      const vals: unknown[] = [attendanceId, employee.id, employee.employee_name, today(), now, "Present", "Portal"]
      if (withSession) {
        cols.splice(5, 0, "active_since")
        vals.splice(5, 0, now)
      }
      if (withLocation) {
        cols.push("location", "latitude", "longitude")
        vals.push(location, latitude, longitude)
      }
      await query(
        `INSERT INTO hr_attendance (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        vals,
      )
      return NextResponse.json({ ok: true, state: "in", clockIn: now, clockOut: null })
    }

    // Currently in an open session → clock out, accumulate worked hours, and
    // recompute the break total as the day's span minus worked time.
    if (isOpen(record, withSession)) {
      const firstIn = record.clock_in || sessionStart(record, withSession)
      const sessionHours = hoursBetween(sessionStart(record, withSession), now)
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
    params.push(record.id)
    await query(`UPDATE hr_attendance SET ${sets.join(", ")} WHERE id = ?`, params)
    return NextResponse.json({ ok: true, state: "in", clockIn: firstIn, clockOut: null })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update attendance" }, { status: 500 })
  }
}
