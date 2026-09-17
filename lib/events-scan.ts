import "server-only"
import { query } from "@/lib/db"
import {
  ensureEventsAccessSchema,
  isEventClosed,
  isWithinAccessWindow,
  logScan,
  type ScanResult,
} from "@/lib/events-access"

// ---------------------------------------------------------------------------
// Server-side QR verification (Phases 10-15, 22, 65, 82-85).
//
// Everything here is authoritative: employee status, event status and the
// access window are re-checked LIVE from the database, never trusted from the
// token or the browser. The token only points at a participant row.
// ---------------------------------------------------------------------------

export type ScanEmployee = {
  name: string | null
  designation: string | null
  department: string | null
  employmentStatus: string | null
  dob: string | null
  photoUrl: string | null
}

export type ScanEvent = {
  id: number
  name: string
  venue: string | null
  startAt: string
  endAt: string
  status: string
}

export type ScanVerification = {
  result: ScanResult
  approved: boolean
  title: string
  message: string
  event?: ScanEvent
  employee?: ScanEmployee
  accessStatus?: string
  checkedInAt?: string | null
  checkedOutAt?: string | null
}

const MESSAGES: Record<ScanResult, { title: string; message: string; approved: boolean }> = {
  APPROVED: { title: "Access Approved", message: "Entry authorized.", approved: true },
  ALREADY_CHECKED_IN: { title: "Already Checked In", message: "This employee has already checked in.", approved: true },
  CHECKED_OUT: { title: "Checked Out", message: "Check-out recorded.", approved: true },
  INACTIVE_EMPLOYEE: { title: "Access Denied", message: "You are inactive and are not authorized to access this event.", approved: false },
  NOT_AUTHORIZED: { title: "Access Denied", message: "Access denied. You are not registered for this event.", approved: false },
  QR_EXPIRED: { title: "Expired QR", message: "Invalid or expired access QR.", approved: false },
  QR_REVOKED: { title: "Access Denied", message: "This access QR has been revoked.", approved: false },
  EVENT_CLOSED: { title: "Event Closed", message: "Event access is closed.", approved: false },
  EVENT_NOT_OPEN: { title: "Access Not Open", message: "Event access window is not open yet.", approved: false },
  INVALID_TOKEN: { title: "Invalid QR", message: "Invalid or expired access QR.", approved: false },
  RATE_LIMITED: { title: "Too Many Attempts", message: "Too many attempts. Please wait a moment and try again.", approved: false },
}

function build(result: ScanResult, extra: Partial<ScanVerification> = {}): ScanVerification {
  const m = MESSAGES[result]
  return { result, approved: m.approved, title: m.title, message: m.message, ...extra }
}

function isActive(status: string | null | undefined): boolean {
  return String(status || "").trim().toLowerCase() === "active"
}

type ParticipantJoin = {
  participant_id: number
  event_id: number
  employee_pk: number
  token_active: number
  access_status: string
  checked_in_at: string | null
  checked_out_at: string | null
  ev_name: string
  location: string | null
  start_at: string
  end_at: string
  ev_status: string
  access_before_minutes: number
  access_after_minutes: number
  allow_dob: number
}

/**
 * Verify a participant token and optionally perform a check-in / check-out.
 * `action`:
 *   - "verify"   → only report the decision (used for read-only page load)
 *   - "checkin"  → first successful scan marks Checked In (Phase 21/22)
 *   - "checkout" → authorized second action marks Checked Out (Phase 23)
 */
export async function verifyParticipantToken(
  token: string,
  action: "verify" | "checkin" | "checkout",
  ctx: { scannerName?: string | null; venue?: string | null; deviceInfo?: string | null } = {},
): Promise<ScanVerification> {
  await ensureEventsAccessSchema()

  const cleaned = String(token || "").trim()
  if (!cleaned) return build("INVALID_TOKEN")

  const rows = await query<ParticipantJoin[]>(
    `SELECT p.id AS participant_id, p.event_id, p.employee_pk, p.token_active, p.access_status,
            p.checked_in_at, p.checked_out_at,
            e.name AS ev_name, e.location, e.start_at, e.end_at, e.status AS ev_status,
            e.access_before_minutes, e.access_after_minutes, e.allow_dob
       FROM event_participants p
       JOIN hr_events e ON e.id = p.event_id
      WHERE p.token = ? LIMIT 1`,
    [cleaned],
  )

  const row = rows[0]
  if (!row) {
    await logScan({ tokenRef: cleaned.slice(0, 16), result: "INVALID_TOKEN", reason: "Token not found", ...ctx })
    return build("INVALID_TOKEN")
  }

  const event: ScanEvent = {
    id: row.event_id,
    name: row.ev_name,
    venue: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.ev_status,
  }

  const logBase = {
    eventId: row.event_id,
    participantId: row.participant_id,
    employeePk: row.employee_pk,
    tokenRef: cleaned.slice(0, 16),
    ...ctx,
  }

  // 1. Revoked token / participant.
  if (!row.token_active || row.access_status === "revoked" || row.access_status === "denied") {
    await logScan({ ...logBase, result: "QR_REVOKED", reason: "Token inactive or access revoked" })
    return build("QR_REVOKED", { event })
  }

  // 2. Event closed (completed / cancelled).
  if (isEventClosed(row.ev_status)) {
    await logScan({ ...logBase, result: "EVENT_CLOSED", reason: `Event status ${row.ev_status}` })
    return build("EVENT_CLOSED", { event })
  }

  // 3. Live employee lookup — status/photo/dob checked at scan time.
  const empRows = await query<any[]>(
    "SELECT employee_name, designation, department, employment_status, dob, photo_url FROM hr_employees WHERE id = ? LIMIT 1",
    [row.employee_pk],
  )
  const emp = empRows[0]
  if (!emp) {
    await logScan({ ...logBase, result: "NOT_AUTHORIZED", reason: "Employee record missing" })
    return build("NOT_AUTHORIZED", { event })
  }

  const employee: ScanEmployee = {
    name: emp.employee_name ?? null,
    designation: emp.designation ?? null,
    department: emp.department ?? null,
    employmentStatus: emp.employment_status ?? null,
    dob: row.allow_dob ? (emp.dob ?? null) : null,
    photoUrl: emp.photo_url ?? null,
  }

  // 4. Inactive employee (Phase 12/35/82).
  if (!isActive(emp.employment_status)) {
    await logScan({ ...logBase, employeeName: emp.employee_name, result: "INACTIVE_EMPLOYEE", reason: `Status ${emp.employment_status}` })
    return build("INACTIVE_EMPLOYEE", { event, employee, accessStatus: row.access_status })
  }

  // 5. Access window (Phase 16/84).
  if (!isWithinAccessWindow(row)) {
    const result: ScanResult = "EVENT_NOT_OPEN"
    await logScan({ ...logBase, employeeName: emp.employee_name, result, reason: "Outside access window" })
    return build(result, { event, employee, accessStatus: row.access_status })
  }

  // ---- At this point the employee is authorized and the window is open. ----

  if (action === "checkout") {
    const res = await query<any>(
      "UPDATE event_participants SET access_status='checked_out', checked_out_at=NOW() WHERE id=? AND checked_in_at IS NOT NULL AND checked_out_at IS NULL",
      [row.participant_id],
    )
    if (res?.affectedRows) {
      await logScan({ ...logBase, employeeName: emp.employee_name, result: "CHECKED_OUT", reason: "Checked out" })
      return build("CHECKED_OUT", { event, employee, accessStatus: "checked_out", checkedInAt: row.checked_in_at })
    }
    // Nothing to check out — fall through to report current state.
  }

  // Already checked in (Phase 22): report original time, no duplicate.
  if (row.checked_in_at) {
    await logScan({ ...logBase, employeeName: emp.employee_name, result: "ALREADY_CHECKED_IN", reason: "Duplicate scan" })
    return build("ALREADY_CHECKED_IN", {
      event,
      employee,
      accessStatus: row.access_status,
      checkedInAt: row.checked_in_at,
      checkedOutAt: row.checked_out_at,
    })
  }

  if (action === "verify") {
    // Read-only: authorized, but do not record a check-in yet.
    await logScan({ ...logBase, employeeName: emp.employee_name, result: "APPROVED", reason: "Verified (no check-in)" })
    return build("APPROVED", { event, employee, accessStatus: "allowed" })
  }

  // First successful check-in — conditional UPDATE prevents concurrent duplicates (Phase 65).
  const res = await query<any>(
    "UPDATE event_participants SET access_status='checked_in', checked_in_at=NOW() WHERE id=? AND checked_in_at IS NULL",
    [row.participant_id],
  )
  if (res?.affectedRows) {
    const fresh = await query<{ checked_in_at: string }[]>(
      "SELECT checked_in_at FROM event_participants WHERE id = ?",
      [row.participant_id],
    )
    await logScan({ ...logBase, employeeName: emp.employee_name, result: "APPROVED", reason: "Checked in" })
    return build("APPROVED", { event, employee, accessStatus: "checked_in", checkedInAt: fresh[0]?.checked_in_at ?? null })
  }

  // A concurrent scan won the race — report already-checked-in.
  const now = await query<{ checked_in_at: string; access_status: string }[]>(
    "SELECT checked_in_at, access_status FROM event_participants WHERE id = ?",
    [row.participant_id],
  )
  await logScan({ ...logBase, employeeName: emp.employee_name, result: "ALREADY_CHECKED_IN", reason: "Concurrent scan" })
  return build("ALREADY_CHECKED_IN", { event, employee, accessStatus: now[0]?.access_status ?? "checked_in", checkedInAt: now[0]?.checked_in_at ?? null })
}
