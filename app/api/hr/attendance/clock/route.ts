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
 * created before the location feature won't have them (the CREATE TABLE IF NOT
 * EXISTS migration is skipped for an existing table), so we detect once and
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
 * Ensure the `active_since` column exists. It records the start of the current
 * open work session so a day can hold several clock-in / clock-out cycles in a
 * single row: worked hours accumulate per session and the gaps between sessions
 * (breaks) are never counted. Detected + created once, then cached.
 */
let sessionColumnReady: boolean | null = null
async function ensureSessionColumn(): Promise<boolean> {
  if (sessionColumnReady !== null) return sessionColumnReady
  try {
    const rows = await query<{ Field: string }[]>("SHOW COLUMNS FROM hr_attendance LIKE 'active_since'")
    if (rows.length === 0) {
      await query("ALTER TABLE hr_attendance ADD COLUMN active_since DATETIME NULL DEFAULT NULL")
    }
    sessionColumnReady = true
  } catch {
    sessionColumnReady = false
  }
  return sessionColumnReady
}

async function todaysRecord(employeeId: number): Promise<AttendanceRow | null> {
  const rows = await query<AttendanceRow[]>(
    "SELECT id, clock_in, clock_out, break_minutes, working_hours, active_since, work_date FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
    [employeeId, today()],
  )
  return rows[0] ?? null
}

/** "in" = currently in an open session; "out" = not clocked in (may clock in). */
function stateOf(record: AttendanceRow | null) {
  if (record && record.active_since) return "in" as const
  return "out" as const
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureSessionColumn()
    const employee = await ensureEmployee(session)

    const record = await todaysRecord(employee.id)
    return NextResponse.json({
      linked: true,
      state: stateOf(record),
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

    await ensureSessionColumn()
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

    const record = await todaysRecord(employee.id)
    const now = nowDateTime()
    const withLocation = await hasLocationColumns()

    // First punch of the day → create the row and open a session (clock in).
    if (!record) {
      const attendanceId = `ATT-${employee.id}-${today().replace(/-/g, "")}`
      if (withLocation) {
        await query(
          "INSERT INTO hr_attendance (attendance_id, employee_id, employee_name, work_date, clock_in, active_since, status, source, location, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, 'Present', 'Portal', ?, ?, ?)",
          [attendanceId, employee.id, employee.employee_name, today(), now, now, location, latitude, longitude],
        )
      } else {
        await query(
          "INSERT INTO hr_attendance (attendance_id, employee_id, employee_name, work_date, clock_in, active_since, status, source) VALUES (?, ?, ?, ?, ?, ?, 'Present', 'Portal')",
          [attendanceId, employee.id, employee.employee_name, today(), now, now],
        )
      }
      return NextResponse.json({ ok: true, state: "in", clockIn: now, clockOut: null })
    }

    // Currently in an open session → clock out, accumulate worked hours, and
    // recompute the break total as the day's span minus worked time.
    if (record.active_since) {
      const firstIn = record.clock_in || record.active_since
      const sessionHours = hoursBetween(record.active_since, now)
      const worked = Number((Number(record.working_hours || 0) + sessionHours).toFixed(2))
      const spanMinutes = hoursBetween(firstIn, now) * 60
      const breakMinutes = Math.max(0, Math.round(spanMinutes - worked * 60))
      if (withLocation) {
        await query(
          "UPDATE hr_attendance SET clock_out = ?, active_since = NULL, working_hours = ?, break_minutes = ?, location = COALESCE(?, location), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude) WHERE id = ?",
          [now, worked, breakMinutes, location, latitude, longitude, record.id],
        )
      } else {
        await query(
          "UPDATE hr_attendance SET clock_out = ?, active_since = NULL, working_hours = ?, break_minutes = ? WHERE id = ?",
          [now, worked, breakMinutes, record.id],
        )
      }
      return NextResponse.json({ ok: true, state: "out", clockIn: firstIn, clockOut: now, workedHours: worked })
    }

    // Row exists but no open session → start a new session (clock in again).
    // Keep the day's first clock_in, clear the visible clock_out while working.
    const firstIn = record.clock_in || now
    if (withLocation) {
      await query(
        "UPDATE hr_attendance SET clock_in = ?, active_since = ?, clock_out = NULL, source = 'Portal', location = COALESCE(?, location), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude) WHERE id = ?",
        [firstIn, now, location, latitude, longitude, record.id],
      )
    } else {
      await query(
        "UPDATE hr_attendance SET clock_in = ?, active_since = ?, clock_out = NULL, source = 'Portal' WHERE id = ?",
        [firstIn, now, record.id],
      )
    }
    return NextResponse.json({ ok: true, state: "in", clockIn: firstIn, clockOut: null })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update attendance" }, { status: 500 })
  }
}
