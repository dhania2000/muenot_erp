import { pool, query } from "@/lib/db"

/**
 * HR Leave engine.
 *
 * Everything here is designed to be self-healing and safe against the two
 * historical quirks of this database:
 *  1. `hr_leave_requests`/`hr_leave_balances` carried foreign keys to a phantom
 *     `employees` table. We treat `hr_employees` as the source of truth and drop
 *     those FKs best-effort so writes never fail on a missing parent row.
 *  2. `hr_leave_requests.leave_type_id` stores the VARCHAR *code* while
 *     `hr_leave_balances.leave_type_id` stores the numeric id. The resolver here
 *     reconciles the two so a request written with either value maps back to a
 *     single leave-type row and a single balance row.
 */

export type LeaveType = {
  id: number
  leave_type_id: string
  leave_type: string
  annual_quota: number
  carry_forward: number
  max_consecutive_days: number
  requires_document: number
  paid: number
  status: string
  description: string | null
  // Extended policy columns (added idempotently).
  allow_half_day: number
  min_days_per_request: number
  max_days_per_request: number
  advance_notice_days: number
  allow_backdated: number
  backdated_limit_days: number
  applicable_gender: string | null
  applicable_employment_type: string | null
  count_weekends: number
  count_holidays: number
  max_requests_per_year: number
}

export type DayBreakdown = {
  date: string
  weekday: string
  counted: number
  reason: string
}

export type ValidationMessage = { level: "error" | "warning"; code: string; message: string }

export type LeaveComputation = {
  total: number
  paidDays: number
  lopDays: number
  breakdown: DayBreakdown[]
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// ---------------------------------------------------------------------------
// Schema self-healing
// ---------------------------------------------------------------------------

let schemaReady = false

async function columnExists(table: string, column: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumn(table: string, column: string, definition: string) {
  if (await columnExists(table, column)) return
  try {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  } catch (error) {
    console.log("[v0] leave.addColumn skipped", table, column, (error as Error).message)
  }
}

async function tableColumns(table: string): Promise<Set<string>> {
  const rows = await query<{ COLUMN_NAME: string }[]>(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  )
  return new Set(rows.map((r) => r.COLUMN_NAME))
}

async function dropForeignKeys(table: string, referencedTable: string) {
  try {
    const rows = await query<{ CONSTRAINT_NAME: string }[]>(
      `SELECT CONSTRAINT_NAME FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name = ?`,
      [table, referencedTable],
    )
    for (const row of rows) {
      try {
        await query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``)
      } catch (error) {
        console.log("[v0] leave.dropForeignKey skipped", table, row.CONSTRAINT_NAME, (error as Error).message)
      }
    }
  } catch (error) {
    console.log("[v0] leave.dropForeignKeys lookup failed", table, (error as Error).message)
  }
}

export async function ensureLeaveSchema() {
  if (schemaReady) return

  // Decouple from the phantom `employees` table. hr_employees is the truth.
  await dropForeignKeys("hr_leave_requests", "employees")
  await dropForeignKeys("hr_leave_balances", "employees")
  await dropForeignKeys("hr_leave_quota_history", "hr_employees")

  // --- Leave type policy columns ---
  await addColumn("hr_leave_types", "allow_half_day", "TINYINT(1) NOT NULL DEFAULT 1")
  await addColumn("hr_leave_types", "min_days_per_request", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_types", "max_days_per_request", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_types", "advance_notice_days", "INT NOT NULL DEFAULT 0")
  await addColumn("hr_leave_types", "allow_backdated", "TINYINT(1) NOT NULL DEFAULT 1")
  await addColumn("hr_leave_types", "backdated_limit_days", "INT NOT NULL DEFAULT 0")
  await addColumn("hr_leave_types", "applicable_gender", "VARCHAR(20) DEFAULT NULL")
  await addColumn("hr_leave_types", "applicable_employment_type", "VARCHAR(150) DEFAULT NULL")
  await addColumn("hr_leave_types", "count_weekends", "TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_types", "count_holidays", "TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_types", "max_requests_per_year", "INT NOT NULL DEFAULT 0")

  // --- Leave request enrichment columns ---
  await addColumn("hr_leave_requests", "breakdown", "LONGTEXT DEFAULT NULL")
  await addColumn("hr_leave_requests", "paid_days", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_requests", "lop_days", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_requests", "is_half_day", "TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_requests", "half_day_session", "VARCHAR(20) DEFAULT NULL")
  await addColumn("hr_leave_requests", "applied_by", "BIGINT DEFAULT NULL")
  await addColumn("hr_leave_requests", "manager_name", "VARCHAR(150) DEFAULT NULL")
  await addColumn("hr_leave_requests", "hr_reviewer_name", "VARCHAR(150) DEFAULT NULL")
  await addColumn("hr_leave_requests", "balance_deducted", "TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("hr_leave_requests", "cancelled_at", "DATETIME DEFAULT NULL")
  await addColumn("hr_leave_requests", "cancelled_by", "BIGINT DEFAULT NULL")
  await addColumn("hr_leave_requests", "cancel_reason", "VARCHAR(500) DEFAULT NULL")

  // --- Timeline / audit trail (no in-app notification centre exists) ---
  await query(
    `CREATE TABLE IF NOT EXISTS hr_leave_timeline (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      request_id VARCHAR(40) NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      message VARCHAR(500) NOT NULL,
      actor_id BIGINT DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_leave_timeline_request (request_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  schemaReady = true
}

// ---------------------------------------------------------------------------
// Leave types + resolver
// ---------------------------------------------------------------------------

const TYPE_SELECT = `SELECT id, leave_type_id, leave_type, annual_quota, carry_forward, max_consecutive_days,
  requires_document, paid, status, description,
  allow_half_day, min_days_per_request, max_days_per_request, advance_notice_days,
  allow_backdated, backdated_limit_days, applicable_gender, applicable_employment_type,
  count_weekends, count_holidays, max_requests_per_year
  FROM hr_leave_types`

export async function listLeaveTypes(activeOnly = false): Promise<LeaveType[]> {
  await ensureLeaveSchema()
  const where = activeOnly ? " WHERE status = 'Active'" : ""
  return query<LeaveType[]>(`${TYPE_SELECT}${where} ORDER BY status = 'Active' DESC, leave_type ASC`)
}

/** Reconcile a request's leave_type_id (code OR numeric) to a single type row. */
export async function resolveLeaveType(identifier: string | number | null | undefined): Promise<LeaveType | null> {
  await ensureLeaveSchema()
  if (identifier === null || identifier === undefined || identifier === "") return null
  const raw = String(identifier).trim()
  const rows = await query<LeaveType[]>(
    `${TYPE_SELECT} WHERE leave_type_id = ? OR CAST(id AS CHAR) = ? LIMIT 1`,
    [raw, raw],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Employees + managers
// ---------------------------------------------------------------------------

export type EmployeeLite = {
  id: number
  employee_id: string
  employee_name: string
  department: string | null
  designation: string | null
  reporting_manager: string | null
  gender: string | null
  employment_type: string | null
  official_email: string | null
  personal_email: string | null
}

const EMP_SELECT = `SELECT id, employee_id, employee_name, department, designation, reporting_manager,
  gender, employment_type, official_email, personal_email FROM hr_employees`

export async function getEmployeeById(id: number | string): Promise<EmployeeLite | null> {
  const rows = await query<EmployeeLite[]>(`${EMP_SELECT} WHERE id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

/** Self-service identity: match the logged-in user's email to an employee record. */
export async function getEmployeeByEmail(email: string): Promise<EmployeeLite | null> {
  if (!email) return null
  const rows = await query<EmployeeLite[]>(
    `${EMP_SELECT} WHERE official_email = ? OR personal_email = ? ORDER BY archived_at IS NULL DESC LIMIT 1`,
    [email, email],
  )
  return rows[0] ?? null
}

/** Best-effort manager lookup: reporting_manager holds a name; find their record. */
export async function deriveManager(employee: EmployeeLite | null): Promise<EmployeeLite | null> {
  if (!employee?.reporting_manager) return null
  const rows = await query<EmployeeLite[]>(
    `${EMP_SELECT} WHERE employee_name = ? OR employee_id = ? LIMIT 1`,
    [employee.reporting_manager, employee.reporting_manager],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Day calculation
// ---------------------------------------------------------------------------

function toDate(value: string) {
  return new Date(`${value}T00:00:00`)
}

function fmt(date: Date) {
  return date.toISOString().slice(0, 10)
}

async function getHolidaySet(from: string, to: string): Promise<Set<string>> {
  const set = new Set<string>()
  try {
    const rows = await query<{ holiday_date: any }[]>(
      `SELECT holiday_date FROM hr_holidays
       WHERE holiday_date BETWEEN ? AND ? AND (status = 'Active' OR status IS NULL) AND (optional = 0 OR optional IS NULL)`,
      [from, to],
    )
    for (const row of rows) {
      const value = row.holiday_date instanceof Date ? fmt(row.holiday_date) : String(row.holiday_date).slice(0, 10)
      set.add(value)
    }
  } catch (error) {
    console.log("[v0] leave.getHolidaySet skipped", (error as Error).message)
  }
  return set
}

/** Compute counted leave days honouring weekend/holiday policy and half-day. */
export async function computeLeaveDays(
  fromDate: string,
  toDate: string,
  type: LeaveType,
  isHalfDay: boolean,
): Promise<{ total: number; breakdown: DayBreakdown[] }> {
  const start = toDateOnly(fromDate)
  const end = toDateOnly(toDate)
  const holidays = await getHolidaySet(fromDate, toDate)
  const breakdown: DayBreakdown[] = []
  let total = 0

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = fmt(d)
    const dow = d.getDay()
    const isWeekend = dow === 0 || dow === 6
    const isHoliday = holidays.has(iso)
    let counted = 1
    let reason = "Working day"
    if (isWeekend && !type.count_weekends) {
      counted = 0
      reason = "Weekend (not counted)"
    } else if (isHoliday && !type.count_holidays) {
      counted = 0
      reason = "Holiday (not counted)"
    } else if (isWeekend) {
      reason = "Weekend (counted by policy)"
    } else if (isHoliday) {
      reason = "Holiday (counted by policy)"
    }
    breakdown.push({ date: iso, weekday: WEEKDAY[dow], counted, reason })
    total += counted
  }

  if (isHalfDay && total > 0) {
    // Half-day only applies to a single counted day.
    total = 0.5
    const first = breakdown.find((b) => b.counted > 0)
    if (first) {
      first.counted = 0.5
      first.reason = "Half day"
    }
  }

  return { total, breakdown }
}

function toDateOnly(value: string) {
  const d = toDate(value)
  d.setHours(0, 0, 0, 0)
  return d
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export type BalanceRow = {
  balance_id: number
  employee_id: number
  leave_type_id: number
  year: number
  opening: number
  accrued: number
  used: number
  pending: number
  adjusted: number
  available: number
}

export async function getOrCreateBalance(
  conn: any,
  employeeId: number,
  leaveType: LeaveType,
  year: number,
): Promise<BalanceRow> {
  const [existing] = await conn.query(
    `SELECT * FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ? LIMIT 1`,
    [employeeId, leaveType.id, year],
  )
  if (existing.length) return existing[0]
  // Seed opening from the type's annual quota so first-time applicants have a balance.
  await conn.query(
    `INSERT INTO hr_leave_balances (employee_id, leave_type_id, \`year\`, opening, accrued, used, pending, adjusted)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0)
     ON DUPLICATE KEY UPDATE employee_id = employee_id`,
    [employeeId, leaveType.id, year, Number(leaveType.annual_quota) || 0],
  )
  const [rows] = await conn.query(
    `SELECT * FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ? LIMIT 1`,
    [employeeId, leaveType.id, year],
  )
  return rows[0]
}

/** Read-only snapshot used by the UI/context endpoints. */
export async function getBalanceSnapshot(employeeId: number, leaveType: LeaveType, year: number) {
  await ensureLeaveSchema()
  const rows = await query<BalanceRow[]>(
    `SELECT * FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ? LIMIT 1`,
    [employeeId, leaveType.id, year],
  )
  if (rows[0]) return rows[0]
  const opening = Number(leaveType.annual_quota) || 0
  return {
    balance_id: 0,
    employee_id: employeeId,
    leave_type_id: leaveType.id,
    year,
    opening,
    accrued: 0,
    used: 0,
    pending: 0,
    adjusted: 0,
    available: opening,
  } as BalanceRow
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type LeaveInput = {
  employee_id: number
  from_date: string
  to_date: string
  leave_type_id: string | number
  is_half_day?: boolean
  half_day_session?: string | null
  reason?: string
  attachment_url?: string | null
  excludeRequestId?: string
}

export type ValidationResult = {
  ok: boolean
  errors: ValidationMessage[]
  warnings: ValidationMessage[]
  computation: LeaveComputation | null
  leaveType: LeaveType | null
  balance: BalanceRow | null
}

export async function validateLeave(input: LeaveInput): Promise<ValidationResult> {
  await ensureLeaveSchema()
  const errors: ValidationMessage[] = []
  const warnings: ValidationMessage[] = []

  const employee = await getEmployeeById(input.employee_id)
  if (!employee) errors.push({ level: "error", code: "employee", message: "Employee record not found." })

  const leaveType = await resolveLeaveType(input.leave_type_id)
  if (!leaveType) {
    errors.push({ level: "error", code: "leave_type", message: "Select a valid leave type." })
    return { ok: false, errors, warnings, computation: null, leaveType: null, balance: null }
  }
  if (leaveType.status !== "Active") {
    errors.push({ level: "error", code: "leave_type_inactive", message: `${leaveType.leave_type} is inactive.` })
  }

  const from = input.from_date
  const to = input.to_date
  if (!from || !to) {
    errors.push({ level: "error", code: "dates", message: "From and to dates are required." })
    return { ok: false, errors, warnings, computation: null, leaveType, balance: null }
  }
  if (toDateOnly(to) < toDateOnly(from)) {
    errors.push({ level: "error", code: "date_order", message: "End date cannot be before start date." })
  }

  const isHalfDay = Boolean(input.is_half_day)
  if (isHalfDay) {
    if (from !== to) {
      errors.push({ level: "error", code: "half_day_range", message: "Half-day leave must be a single day." })
    }
    if (!leaveType.allow_half_day) {
      errors.push({ level: "error", code: "half_day_not_allowed", message: `${leaveType.leave_type} does not allow half-day.` })
    }
  }

  // Policy: gender applicability.
  const genderPolicy = (leaveType.applicable_gender || "").trim().toLowerCase()
  if (genderPolicy && genderPolicy !== "any" && employee?.gender) {
    if (employee.gender.trim().toLowerCase() !== genderPolicy) {
      errors.push({ level: "error", code: "gender", message: `${leaveType.leave_type} applies to ${leaveType.applicable_gender} employees only.` })
    }
  }

  // Policy: employment type applicability (comma list).
  const empTypePolicy = (leaveType.applicable_employment_type || "").trim()
  if (empTypePolicy && employee?.employment_type) {
    const allowed = empTypePolicy.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean)
    if (allowed.length && !allowed.includes(employee.employment_type.trim().toLowerCase())) {
      errors.push({ level: "error", code: "employment_type", message: `${leaveType.leave_type} is limited to: ${leaveType.applicable_employment_type}.` })
    }
  }

  const { total, breakdown } = await computeLeaveDays(from, to, leaveType, isHalfDay)
  if (total <= 0) {
    errors.push({ level: "error", code: "zero_days", message: "Selected range has no countable leave days (all weekends/holidays)." })
  }

  // Policy: advance notice / backdating.
  const today = toDateOnly(fmt(new Date()))
  const startsAt = toDateOnly(from)
  const noticeDays = Math.round((startsAt.getTime() - today.getTime()) / 86400000)
  if (noticeDays < 0) {
    if (!leaveType.allow_backdated) {
      errors.push({ level: "error", code: "backdated", message: `${leaveType.leave_type} cannot be applied for past dates.` })
    } else if (leaveType.backdated_limit_days > 0 && Math.abs(noticeDays) > leaveType.backdated_limit_days) {
      errors.push({ level: "error", code: "backdated_limit", message: `Backdated leave allowed only up to ${leaveType.backdated_limit_days} days in the past.` })
    } else {
      warnings.push({ level: "warning", code: "backdated", message: "This is a backdated leave request." })
    }
  } else if (leaveType.advance_notice_days > 0 && noticeDays < leaveType.advance_notice_days) {
    warnings.push({ level: "warning", code: "advance_notice", message: `${leaveType.leave_type} usually needs ${leaveType.advance_notice_days} days advance notice.` })
  }

  // Policy: min / max per request + consecutive cap.
  if (leaveType.min_days_per_request > 0 && total < leaveType.min_days_per_request) {
    errors.push({ level: "error", code: "min_days", message: `Minimum ${leaveType.min_days_per_request} day(s) per request.` })
  }
  if (leaveType.max_days_per_request > 0 && total > leaveType.max_days_per_request) {
    errors.push({ level: "error", code: "max_days", message: `Maximum ${leaveType.max_days_per_request} day(s) per request.` })
  }
  if (leaveType.max_consecutive_days > 0 && total > leaveType.max_consecutive_days) {
    errors.push({ level: "error", code: "max_consecutive", message: `Cannot exceed ${leaveType.max_consecutive_days} consecutive day(s).` })
  }

  // Policy: documentation.
  if (leaveType.requires_document && !input.attachment_url) {
    errors.push({ level: "error", code: "document", message: `${leaveType.leave_type} requires a supporting document.` })
  }

  const year = startsAt.getFullYear()

  // Policy: yearly request cap.
  if (leaveType.max_requests_per_year > 0 && employee) {
    const rows = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM hr_leave_requests
       WHERE employee_id = ? AND leave_type_id IN (?, ?) AND YEAR(from_date) = ?
       AND status NOT IN ('Manager Rejected','HR Rejected','Cancelled')
       AND (? IS NULL OR request_id <> ?)`,
      [employee.id, leaveType.leave_type_id, String(leaveType.id), year, input.excludeRequestId ?? null, input.excludeRequestId ?? null],
    )
    if (Number(rows[0]?.c || 0) >= leaveType.max_requests_per_year) {
      errors.push({ level: "error", code: "max_requests", message: `Reached the yearly limit of ${leaveType.max_requests_per_year} ${leaveType.leave_type} requests.` })
    }
  }

  // Overlap with the employee's own active requests.
  if (employee) {
    const overlaps = await query<any[]>(
      `SELECT request_id, from_date, to_date, leave_type_id FROM hr_leave_requests
       WHERE employee_id = ? AND status NOT IN ('Manager Rejected','HR Rejected','Cancelled')
       AND from_date <= ? AND to_date >= ?
       AND (? IS NULL OR request_id <> ?)`,
      [employee.id, to, from, input.excludeRequestId ?? null, input.excludeRequestId ?? null],
    )
    if (overlaps.length) {
      errors.push({ level: "error", code: "overlap", message: `Overlaps an existing request (${overlaps[0].request_id}).` })
    }

    // Attendance already recorded on these days.
    try {
      const attendance = await query<{ c: number }[]>(
        `SELECT COUNT(*) AS c FROM hr_attendance
         WHERE employee_id = ? AND work_date BETWEEN ? AND ?
         AND (day_type IS NULL OR day_type <> 'Leave')
         AND (status IS NULL OR status NOT IN ('Absent'))`,
        [employee.id, from, to],
      )
      if (Number(attendance[0]?.c || 0) > 0) {
        warnings.push({ level: "warning", code: "attendance", message: "Attendance is already marked on one or more selected days." })
      }
    } catch {
      /* attendance table optional */
    }

    // Team conflict: same-department members on leave over the range.
    if (employee.department) {
      const team = await query<any[]>(
        `SELECT r.employee_name FROM hr_leave_requests r
         JOIN hr_employees e ON e.id = r.employee_id
         WHERE e.department = ? AND r.employee_id <> ?
         AND r.status IN ('Pending','Manager Approved','HR Approved')
         AND r.from_date <= ? AND r.to_date >= ?
         GROUP BY r.employee_name LIMIT 5`,
        [employee.department, employee.id, to, from],
      )
      if (team.length) {
        warnings.push({
          level: "warning",
          code: "team_conflict",
          message: `${team.length} teammate(s) already on leave in this window: ${team.map((t) => t.employee_name).join(", ")}.`,
        })
      }
    }
  }

  // Balance + LOP split.
  let balance: BalanceRow | null = null
  let paidDays = 0
  let lopDays = total
  if (employee) {
    balance = await getBalanceSnapshot(employee.id, leaveType, year)
    if (leaveType.paid) {
      const available = Number(balance.available) || 0
      paidDays = Math.max(0, Math.min(total, available))
      lopDays = Math.round((total - paidDays) * 100) / 100
      if (lopDays > 0) {
        warnings.push({
          level: "warning",
          code: "insufficient_balance",
          message: `Only ${available} day(s) available — ${lopDays} day(s) will be Loss of Pay.`,
        })
      }
    } else {
      warnings.push({ level: "warning", code: "unpaid", message: `${leaveType.leave_type} is unpaid (Loss of Pay).` })
    }
  }

  const computation: LeaveComputation = { total, paidDays, lopDays, breakdown }
  return { ok: errors.length === 0, errors, warnings, computation, leaveType, balance }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export async function addTimeline(
  requestId: string,
  eventType: string,
  message: string,
  actor?: { id?: number | null; name?: string | null },
) {
  try {
    await query(
      `INSERT INTO hr_leave_timeline (request_id, event_type, message, actor_id, actor_name)
       VALUES (?, ?, ?, ?, ?)`,
      [requestId, eventType, message, actor?.id ?? null, actor?.name ?? null],
    )
  } catch (error) {
    console.log("[v0] leave.addTimeline failed", (error as Error).message)
  }
}

export async function getTimeline(requestId: string) {
  await ensureLeaveSchema()
  return query<any[]>(
    `SELECT * FROM hr_leave_timeline WHERE request_id = ? ORDER BY created_at ASC, id ASC`,
    [requestId],
  )
}

// ---------------------------------------------------------------------------
// Email notifications (best-effort)
// ---------------------------------------------------------------------------

export async function notifyByEmail(to: string | null | undefined, subject: string, html: string) {
  if (!to) return
  try {
    const { sendEmail, hydrateDepartmentSMTP } = await import("@/lib/email")
    await hydrateDepartmentSMTP("hr")
    await sendEmail({ to, subject, html, department: "hr" })
  } catch (error) {
    console.log("[v0] leave.notifyByEmail failed", (error as Error).message)
  }
}

function emailShell(title: string, body: string) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">
    <h2 style="color:#111827;font-size:18px">${title}</h2>
    <div style="color:#374151;font-size:14px;line-height:1.6">${body}</div>
    <p style="color:#9ca3af;font-size:12px;margin-top:24px">Muenot ERP — HR Leave</p>
  </div>`
}

// ---------------------------------------------------------------------------
// Quota history + attendance (defensive writes inside a transaction)
// ---------------------------------------------------------------------------

async function writeQuotaHistory(
  conn: any,
  cols: Set<string>,
  data: { employee_id: number; leave_type_id: number; year: number; event_type: string; days: number; reference: string; reason: string; created_by: number | null },
) {
  const row: Record<string, any> = {
    employee_id: data.employee_id,
    leave_type_id: data.leave_type_id,
    year: data.year,
    event_type: data.event_type,
    days: data.days,
    reference: data.reference,
    reason: data.reason,
    created_by: data.created_by,
  }
  const keys = Object.keys(row).filter((k) => cols.has(k))
  if (!keys.length) return
  await conn.query(
    `INSERT INTO hr_leave_quota_history (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    keys.map((k) => row[k]),
  )
}

async function markAttendance(conn: any, requestId: string, employeeId: number, breakdown: DayBreakdown[]) {
  try {
    const [colRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'hr_attendance'`,
    )
    const cols = new Set((colRows as any[]).map((r) => r.COLUMN_NAME))
    if (!cols.has("leave_request_id")) return
    for (const day of breakdown) {
      if (day.counted <= 0) continue
      const [existing] = await conn.query(
        `SELECT id FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1`,
        [employeeId, day.date],
      )
      if (existing.length) {
        await conn.query(
          `UPDATE hr_attendance SET day_type = 'Leave', leave_request_id = ?${cols.has("status") ? ", status = 'On Leave'" : ""} WHERE employee_id = ? AND work_date = ?`,
          [requestId, employeeId, day.date],
        )
      } else {
        const insertCols = ["employee_id", "work_date", "day_type", "leave_request_id"]
        const values: any[] = [employeeId, day.date, "Leave", requestId]
        if (cols.has("status")) {
          insertCols.push("status")
          values.push("On Leave")
        }
        await conn.query(
          `INSERT INTO hr_attendance (${insertCols.join(",")}) VALUES (${insertCols.map(() => "?").join(",")})`,
          values,
        )
      }
    }
  } catch (error) {
    console.log("[v0] leave.markAttendance skipped", (error as Error).message)
  }
}

async function unmarkAttendance(conn: any, requestId: string) {
  try {
    await conn.query(`DELETE FROM hr_attendance WHERE leave_request_id = ?`, [requestId])
  } catch (error) {
    console.log("[v0] leave.unmarkAttendance skipped", (error as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type Actor = { userId: number; name: string; email: string; role: "admin" | "employee" }

export async function createLeaveRequest(input: LeaveInput & { reason: string }, actor: Actor, requestId: string) {
  await ensureLeaveSchema()
  const validation = await validateLeave(input)
  if (!validation.ok || !validation.computation || !validation.leaveType) {
    return { ok: false as const, validation }
  }
  const employee = await getEmployeeById(input.employee_id)
  if (!employee) return { ok: false as const, validation }

  const manager = await deriveManager(employee)
  const { total, paidDays, lopDays, breakdown } = validation.computation
  const leaveType = validation.leaveType
  const year = toDateOnly(input.from_date).getFullYear()

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await conn.query(
      `INSERT INTO hr_leave_requests
        (request_id, employee_id, employee_name, leave_type_id, from_date, to_date, days, reason,
         attachment_url, status, manager_id, manager_name, requested_at,
         breakdown, paid_days, lop_days, is_half_day, half_day_session, applied_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        employee.id,
        employee.employee_name,
        leaveType.leave_type_id,
        input.from_date,
        input.to_date,
        total,
        input.reason,
        input.attachment_url ?? null,
        manager?.id ?? null,
        manager?.employee_name ?? employee.reporting_manager ?? null,
        JSON.stringify(breakdown),
        paidDays,
        lopDays,
        input.is_half_day ? 1 : 0,
        input.half_day_session ?? null,
        actor.userId,
      ],
    )

    // Reserve paid days as pending against the balance.
    if (leaveType.paid && paidDays > 0) {
      await getOrCreateBalance(conn, employee.id, leaveType, year)
      await conn.query(
        `UPDATE hr_leave_balances SET pending = pending + ? WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ?`,
        [paidDays, employee.id, leaveType.id, year],
      )
    }

    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  await addTimeline(requestId, "applied", `${employee.employee_name} applied for ${leaveType.leave_type} (${total} day(s))`, {
    id: actor.userId,
    name: actor.name,
  })

  // Notify the manager (best-effort).
  const managerEmail = manager?.official_email || manager?.personal_email
  await notifyByEmail(
    managerEmail,
    `Leave approval needed — ${employee.employee_name}`,
    emailShell(
      "New leave request",
      `<p><strong>${employee.employee_name}</strong> requested <strong>${leaveType.leave_type}</strong>.</p>
       <p>Dates: ${input.from_date} → ${input.to_date} (${total} day(s))</p>
       <p>Reason: ${input.reason}</p>
       <p>Please review in the HR portal (ref ${requestId}).</p>`,
    ),
  )

  return { ok: true as const, requestId, validation }
}

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

export type LeaveAction = "manager_approve" | "manager_reject" | "hr_approve" | "hr_reject" | "cancel"

const ALLOWED_FROM: Record<LeaveAction, string[]> = {
  manager_approve: ["Pending"],
  manager_reject: ["Pending"],
  hr_approve: ["Pending", "Manager Approved"],
  hr_reject: ["Pending", "Manager Approved"],
  cancel: ["Pending", "Manager Approved", "HR Approved"],
}

const NEXT_STATUS: Record<LeaveAction, string> = {
  manager_approve: "Manager Approved",
  manager_reject: "Manager Rejected",
  hr_approve: "HR Approved",
  hr_reject: "HR Rejected",
  cancel: "Cancelled",
}

export async function transitionLeave(
  requestId: string,
  action: LeaveAction,
  actor: Actor,
  remarks?: string | null,
) {
  await ensureLeaveSchema()
  const rows = await query<any[]>(`SELECT * FROM hr_leave_requests WHERE request_id = ? LIMIT 1`, [requestId])
  const request = rows[0]
  if (!request) return { ok: false as const, error: "Request not found", status: 404 }

  if (!ALLOWED_FROM[action].includes(request.status)) {
    return { ok: false as const, error: `Cannot ${action.replace("_", " ")} a request that is ${request.status}.`, status: 409 }
  }

  // Block self-approval (manager/HR cannot action their own request).
  const isApproval = action === "manager_approve" || action === "hr_approve" || action === "manager_reject" || action === "hr_reject"
  if (isApproval && actor.role !== "admin") {
    if (Number(request.applied_by) === Number(actor.userId)) {
      return { ok: false as const, error: "You cannot approve or reject your own leave request.", status: 403 }
    }
  }

  const leaveType = await resolveLeaveType(request.leave_type_id)
  const year = toDateOnly(String(request.from_date).slice(0, 10)).getFullYear()
  const paidDays = Number(request.paid_days) || 0
  const nextStatus = NEXT_STATUS[action]
  const wasDeducted = Number(request.balance_deducted) === 1
  const breakdown: DayBreakdown[] = safeParse(request.breakdown)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const releasesPending = ["manager_reject", "hr_reject", "cancel"].includes(action)
    const deducts = action === "hr_approve"

    if (leaveType && paidDays > 0) {
      await getOrCreateBalance(conn, Number(request.employee_id), leaveType, year)

      if (deducts) {
        // pending -> used.
        await conn.query(
          `UPDATE hr_leave_balances SET pending = GREATEST(0, pending - ?), used = used + ?
           WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ?`,
          [paidDays, paidDays, request.employee_id, leaveType.id, year],
        )
        const [balRows] = await conn.query(
          `SELECT available FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ?`,
          [request.employee_id, leaveType.id, year],
        )
        await writeQuotaHistory(conn, await tableColumns("hr_leave_quota_history"), {
          employee_id: Number(request.employee_id),
          leave_type_id: leaveType.id,
          year,
          event_type: "leave_approved",
          days: -paidDays,
          reference: requestId,
          reason: `Leave approved (${request.from_date} → ${request.to_date})`,
          created_by: actor.userId,
        })
        void balRows
        await markAttendance(conn, requestId, Number(request.employee_id), breakdown)
      } else if (releasesPending && !wasDeducted && request.status !== "HR Approved") {
        // Never deducted -> just release the pending reservation.
        await conn.query(
          `UPDATE hr_leave_balances SET pending = GREATEST(0, pending - ?)
           WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ?`,
          [paidDays, request.employee_id, leaveType.id, year],
        )
      } else if (releasesPending && (wasDeducted || request.status === "HR Approved")) {
        // Reverse a prior deduction (cancelling an approved leave).
        await conn.query(
          `UPDATE hr_leave_balances SET used = GREATEST(0, used - ?)
           WHERE employee_id = ? AND leave_type_id = ? AND \`year\` = ?`,
          [paidDays, request.employee_id, leaveType.id, year],
        )
        await writeQuotaHistory(conn, await tableColumns("hr_leave_quota_history"), {
          employee_id: Number(request.employee_id),
          leave_type_id: leaveType.id,
          year,
          event_type: "leave_reversed",
          days: paidDays,
          reference: requestId,
          reason: `Leave ${nextStatus.toLowerCase()} — balance restored`,
          created_by: actor.userId,
        })
        await unmarkAttendance(conn, requestId)
      }
    }

    // Persist the request state.
    const isManagerStage = action === "manager_approve" || action === "manager_reject"
    const isHrStage = action === "hr_approve" || action === "hr_reject"
    await conn.query(
      `UPDATE hr_leave_requests SET
        status = ?,
        remarks = COALESCE(?, remarks),
        balance_deducted = ?,
        manager_id = IF(?, ?, manager_id),
        manager_name = IF(?, ?, manager_name),
        manager_action_at = IF(?, CURRENT_TIMESTAMP, manager_action_at),
        hr_reviewer_id = IF(?, ?, hr_reviewer_id),
        hr_reviewer_name = IF(?, ?, hr_reviewer_name),
        hr_action_at = IF(?, CURRENT_TIMESTAMP, hr_action_at),
        cancelled_at = IF(?, CURRENT_TIMESTAMP, cancelled_at),
        cancelled_by = IF(?, ?, cancelled_by),
        cancel_reason = IF(?, ?, cancel_reason)
       WHERE request_id = ?`,
      [
        nextStatus,
        remarks ?? null,
        deducts ? 1 : (releasesPending ? 0 : wasDeducted ? 1 : 0),
        isManagerStage, actor.userId,
        isManagerStage, actor.name,
        isManagerStage,
        isHrStage, actor.userId,
        isHrStage, actor.name,
        isHrStage,
        action === "cancel", 
        action === "cancel", actor.userId,
        action === "cancel", remarks ?? null,
        requestId,
      ],
    )

    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  const label: Record<LeaveAction, string> = {
    manager_approve: "approved by manager",
    manager_reject: "rejected by manager",
    hr_approve: "approved by HR",
    hr_reject: "rejected by HR",
    cancel: "cancelled",
  }
  await addTimeline(requestId, action, `Request ${label[action]}${remarks ? ` — ${remarks}` : ""}`, {
    id: actor.userId,
    name: actor.name,
  })

  // Notify the applicant on any terminal or stage change.
  const employee = await getEmployeeById(Number(request.employee_id))
  const applicantEmail = employee?.official_email || employee?.personal_email
  await notifyByEmail(
    applicantEmail,
    `Your leave request ${requestId} was ${label[action]}`,
    emailShell(
      "Leave request update",
      `<p>Your ${request.leave_type_id} request (${request.from_date} → ${request.to_date}) was <strong>${label[action]}</strong>.</p>
       ${remarks ? `<p>Remarks: ${remarks}</p>` : ""}
       <p>Current status: <strong>${nextStatus}</strong></p>`,
    ),
  )

  return { ok: true as const, status: nextStatus }
}

function safeParse(value: any): DayBreakdown[] {
  if (!value) return []
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
