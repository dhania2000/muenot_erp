import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

type EmployeeRow = { id: number; employee_name: string }
type AttendanceRow = {
  id: number
  clock_in: string | null
  clock_out: string | null
  break_minutes: number
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

function workingHours(clockIn: string, clockOut: string, breakMinutes: number) {
  const value = (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 3600000 - breakMinutes / 60
  return Math.max(0, Number(value.toFixed(2)))
}

async function resolveEmployee(email: string): Promise<EmployeeRow | null> {
  const rows = await query<EmployeeRow[]>(
    "SELECT id, employee_name FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [email, email],
  )
  return rows[0] ?? null
}

async function todaysRecord(employeeId: number): Promise<AttendanceRow | null> {
  const rows = await query<AttendanceRow[]>(
    "SELECT id, clock_in, clock_out, break_minutes, work_date FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
    [employeeId, today()],
  )
  return rows[0] ?? null
}

function stateOf(record: AttendanceRow | null) {
  if (!record || !record.clock_in) return "out" as const
  if (record.clock_in && !record.clock_out) return "in" as const
  return "done" as const
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const employee = await resolveEmployee(session.email)
    if (!employee) return NextResponse.json({ linked: false, state: "out", clockIn: null, clockOut: null })

    const record = await todaysRecord(employee.id)
    return NextResponse.json({
      linked: true,
      state: stateOf(record),
      clockIn: record?.clock_in ?? null,
      clockOut: record?.clock_out ?? null,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load status" }, { status: 500 })
  }
}

export async function POST() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const employee = await resolveEmployee(session.email)
    if (!employee) {
      return NextResponse.json(
        { error: "No employee record is linked to your account. Ask HR to set your official email on your employee profile." },
        { status: 400 },
      )
    }

    const record = await todaysRecord(employee.id)
    const now = nowDateTime()

    // First punch of the day → clock in.
    if (!record) {
      const attendanceId = `ATT-${employee.id}-${today().replace(/-/g, "")}`
      await query(
        "INSERT INTO hr_attendance (attendance_id, employee_id, employee_name, work_date, clock_in, status, source) VALUES (?, ?, ?, ?, ?, 'Present', 'Portal')",
        [attendanceId, employee.id, employee.employee_name, today(), now],
      )
      return NextResponse.json({ ok: true, state: "in", clockIn: now, clockOut: null })
    }

    // Record exists but no clock_in yet → treat as clock in.
    if (!record.clock_in) {
      await query("UPDATE hr_attendance SET clock_in = ?, source = 'Portal' WHERE id = ?", [now, record.id])
      return NextResponse.json({ ok: true, state: "in", clockIn: now, clockOut: null })
    }

    // Clocked in, not out yet → clock out and compute hours.
    if (!record.clock_out) {
      const hours = workingHours(record.clock_in, now, Number(record.break_minutes || 0))
      await query("UPDATE hr_attendance SET clock_out = ?, working_hours = ? WHERE id = ?", [now, hours, record.id])
      return NextResponse.json({ ok: true, state: "done", clockIn: record.clock_in, clockOut: now })
    }

    // Already completed for the day.
    return NextResponse.json(
      { error: "You have already clocked in and out for today.", state: "done", clockIn: record.clock_in, clockOut: record.clock_out },
      { status: 409 },
    )
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update attendance" }, { status: 500 })
  }
}
