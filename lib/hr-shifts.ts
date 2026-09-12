import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"

// ---------------------------------------------------------------------------
// Shift Master service — the single server-side surface for the configurable
// work-schedule / shift-policy master. It owns schema safety, automatic IDs,
// audit logging and usage lookups. It never stores employee, rotation or
// attendance data — those live in their own modules and are only *read* here.
// Pure maths + validation come from lib/shift-ui.ts so the form and the API
// share one source of truth.
// ---------------------------------------------------------------------------

/** Existing ERP id format (EMP-0001, LR-0001 …). SHIFT is whitelisted already. */
export const SHIFT_ID_PREFIX = "SHIFT"

/** Columns owned by the Shift Master (policy only — no employee/rotation data). */
export const SHIFT_POLICY_COLUMNS = [
  "shift_code",
  "shift_name",
  "start_time",
  "end_time",
  "is_overnight",
  "break_minutes",
  "working_hours",
  "grace_minutes",
  "late_enabled",
  "early_checkout_enabled",
  "early_grace_minutes",
  "overtime_enabled",
  "overtime_eligible",
  "overtime_threshold_minutes",
  "overtime_rounding_minutes",
  "working_days",
  "weekly_offs",
  "effective_from",
  "effective_until",
  "status",
  "description",
] as const

let schemaEnsured: Promise<void> | null = null

/** Idempotently add every policy column + the audit table. Safe to call often. */
export function ensureShiftSchema(): Promise<void> {
  if (!schemaEnsured) schemaEnsured = doEnsureShiftSchema()
  return schemaEnsured
}

async function addColumn(definition: string) {
  try {
    await query(`ALTER TABLE hr_shifts ADD COLUMN ${definition}`)
  } catch {
    // Column already exists (MySQL lacks ADD COLUMN IF NOT EXISTS) — ignore.
  }
}

async function doEnsureShiftSchema() {
  // Policy columns. Every one is nullable / defaulted so existing rows and the
  // older create form keep working unchanged.
  await addColumn("`shift_code` VARCHAR(40) DEFAULT NULL")
  await addColumn("`is_overnight` TINYINT(1) NOT NULL DEFAULT 0")
  await addColumn("`grace_minutes` INT UNSIGNED NOT NULL DEFAULT 10")
  await addColumn("`late_enabled` TINYINT(1) NOT NULL DEFAULT 1")
  await addColumn("`early_checkout_enabled` TINYINT(1) NOT NULL DEFAULT 1")
  await addColumn("`early_grace_minutes` INT UNSIGNED NOT NULL DEFAULT 10")
  await addColumn("`overtime_eligible` TINYINT(1) NOT NULL DEFAULT 1")
  await addColumn("`overtime_threshold_minutes` INT UNSIGNED NOT NULL DEFAULT 0")
  await addColumn("`overtime_rounding_minutes` INT UNSIGNED NOT NULL DEFAULT 0")
  await addColumn("`working_days` VARCHAR(30) DEFAULT NULL")
  await addColumn("`weekly_offs` VARCHAR(30) DEFAULT NULL")
  await addColumn("`effective_from` DATE DEFAULT NULL")
  await addColumn("`effective_until` DATE DEFAULT NULL")
  await addColumn("`created_by` INT UNSIGNED DEFAULT NULL")
  await addColumn("`updated_by` INT UNSIGNED DEFAULT NULL")

  // Unique shift code (MySQL unique index permits multiple NULLs, so blank
  // codes are allowed while set codes stay unique). Indexes for common scans.
  try {
    await query("ALTER TABLE hr_shifts ADD UNIQUE KEY uq_hr_shifts_shift_code (shift_code)")
  } catch {
    // Already present.
  }
  try {
    await query("ALTER TABLE hr_shifts ADD INDEX idx_hr_shifts_effective (effective_from, effective_until)")
  } catch {
    // Already present.
  }

  // Audit trail for shift-policy changes — mirrors hr_employee_events so the UI
  // and reporting patterns stay consistent across HR.
  try {
    await query(`CREATE TABLE IF NOT EXISTS hr_shift_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      shift_id BIGINT UNSIGNED NOT NULL,
      shift_ref VARCHAR(50) DEFAULT NULL,
      shift_name VARCHAR(150) DEFAULT NULL,
      event_type VARCHAR(60) NOT NULL,
      summary VARCHAR(255) NOT NULL,
      changes JSON DEFAULT NULL,
      reason VARCHAR(500) DEFAULT NULL,
      actor_id INT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hr_shift_event_shift (shift_id, created_at),
      KEY idx_hr_shift_event_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  } catch (error) {
    console.error("[v0] ensureShiftSchema (audit table) failed:", (error as Error).message)
  }
}

/** Race-safe, immutable, unique Shift ID (SHIFT-0001) via the shared sequence. */
export async function nextShiftId(): Promise<string> {
  return nextRecordId(SHIFT_ID_PREFIX, { digits: 4 })
}

// ---------------------------------------------------------------------------
// Usage — real assignment counts. Never store an editable count on the master.
// ---------------------------------------------------------------------------

export type ShiftUsage = { activeAssignments: number; totalAssignments: number; assignedEmployees: number }

/** Per-shift assignment counts, keyed by hr_shifts.id. Best-effort (empty on missing table). */
export async function getAssignmentCounts(): Promise<Record<number, ShiftUsage>> {
  try {
    const rows = await query<any[]>(
      `SELECT shift_id,
              SUM(status = 'Active') AS active_assignments,
              COUNT(*) AS total_assignments,
              COUNT(DISTINCT employee_id) AS assigned_employees
       FROM hr_shift_assignments
       GROUP BY shift_id`,
    )
    const map: Record<number, ShiftUsage> = {}
    for (const r of rows) {
      map[Number(r.shift_id)] = {
        activeAssignments: Number(r.active_assignments || 0),
        totalAssignments: Number(r.total_assignments || 0),
        assignedEmployees: Number(r.assigned_employees || 0),
      }
    }
    return map
  } catch {
    return {}
  }
}

/** Assignment history for one shift, enriched from the Employees master (read-only). */
export async function getShiftAssignments(shiftDbId: number): Promise<any[]> {
  try {
    return await query<any[]>(
      `SELECT a.id, a.assignment_id, a.employee_id, a.effective_from, a.effective_to, a.status, a.notes,
              e.employee_name, e.employee_id AS employee_code, e.department, e.designation
       FROM hr_shift_assignments a
       LEFT JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.shift_id = ?
       ORDER BY (a.status = 'Active') DESC, a.effective_from DESC
       LIMIT 200`,
      [shiftDbId],
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Audit — reuse the per-domain event pattern (see hr-employee-events).
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  shift_code: "Shift Code",
  shift_name: "Shift Name",
  start_time: "Start Time",
  end_time: "End Time",
  is_overnight: "Overnight",
  break_minutes: "Break Minutes",
  working_hours: "Net Working Hours",
  grace_minutes: "Grace Period",
  late_enabled: "Late Tracking",
  early_checkout_enabled: "Early Checkout Rule",
  early_grace_minutes: "Early Checkout Grace",
  overtime_enabled: "Overtime Enabled",
  overtime_eligible: "Overtime Eligible",
  overtime_threshold_minutes: "Overtime Threshold",
  overtime_rounding_minutes: "Overtime Rounding",
  working_days: "Working Days",
  weekly_offs: "Weekly Off",
  effective_from: "Effective From",
  effective_until: "Effective Until",
  status: "Status",
  description: "Description",
}

export type ShiftFieldChange = { field: string; label: string; from: unknown; to: unknown }

function norm(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "1" : "0"
  return String(value).trim()
}

/** Field-level diff between the stored row and an incoming update (keys in `next`). */
export function diffShift(current: Record<string, unknown>, next: Record<string, unknown>): ShiftFieldChange[] {
  const changes: ShiftFieldChange[] = []
  for (const key of Object.keys(next)) {
    if (norm(current[key]) !== norm(next[key])) {
      changes.push({
        field: key,
        label: FIELD_LABELS[key] ?? key.replace(/_/g, " "),
        from: current[key] ?? null,
        to: next[key] ?? null,
      })
    }
  }
  return changes
}

export async function logShiftEvent(opts: {
  shiftId: number
  shiftRef?: string | null
  shiftName?: string | null
  type: string
  summary: string
  changes?: ShiftFieldChange[] | null
  reason?: string | null
  actorId?: number | null
  actorName?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO hr_shift_events
         (shift_id, shift_ref, shift_name, event_type, summary, changes, reason, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        opts.shiftId,
        opts.shiftRef ?? null,
        opts.shiftName ?? null,
        opts.type,
        opts.summary,
        opts.changes && opts.changes.length ? JSON.stringify(opts.changes) : null,
        opts.reason ?? null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    // Audit logging must never break the primary operation.
    console.error("[v0] logShiftEvent failed:", (error as Error).message)
  }
}

/** Audit history for one shift, newest first. */
export async function getShiftEvents(shiftDbId: number): Promise<any[]> {
  try {
    return await query<any[]>(
      `SELECT id, event_type, summary, changes, reason, actor_name, created_at
       FROM hr_shift_events WHERE shift_id = ? ORDER BY id DESC LIMIT 100`,
      [shiftDbId],
    )
  } catch {
    return []
  }
}
