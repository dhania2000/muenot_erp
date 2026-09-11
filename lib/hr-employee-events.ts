import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Employee event log — powers both the Audit trail and the activity Timeline
// on the employee profile. See the 2026-09-21 migration for the schema.
// ---------------------------------------------------------------------------

export type EmployeeEventType =
  | "created"
  | "updated"
  | "status_changed"
  | "archived"
  | "reactivated"
  | "deleted"
  | "imported"
  | "bulk_updated"
  | "login_created"
  // Employee Documents lifecycle — surfaced in the profile Timeline/Audit tabs.
  | "document_uploaded"
  | "document_verified"
  | "document_rejected"
  | "document_replaced"
  | "document_archived"
  | "document_restored"
  | "document_deleted"
  | "document_downloaded"

export type EmployeeFieldChange = { field: string; label: string; from: unknown; to: unknown }

// Human-readable labels for the fields we diff. Anything not listed falls back
// to a prettified version of the column name.
const FIELD_LABELS: Record<string, string> = {
  employee_name: "Name",
  gender: "Gender",
  dob: "Date of birth",
  personal_email: "Personal email",
  official_email: "Official email",
  mobile: "Mobile",
  alternate_mobile: "Alternate mobile",
  address: "Address",
  city: "City",
  state: "State",
  country: "Country",
  postal_code: "Postal code",
  department: "Department",
  designation: "Designation",
  reporting_manager: "Reporting manager",
  employment_type: "Employment type",
  joining_date: "Joining date",
  probation_end_date: "Probation end date",
  confirmation_date: "Confirmation date",
  employment_status: "Status",
  onboarding_status: "Onboarding status",
  work_location: "Work location",
  work_mode: "Work mode",
  shift: "Shift",
  employee_grade: "Grade",
  notice_period: "Notice period",
  exit_status: "Exit status",
  exit_date: "Exit date",
  exit_reason: "Exit reason",
  skills: "Skills",
  notes: "Notes",
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Normalize a value for comparison so "" / null / undefined all collapse. */
function norm(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

/**
 * Compute the field-level diff between an existing DB row and an incoming
 * partial update. Only keys present in `next` are considered.
 */
export function diffEmployee(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): EmployeeFieldChange[] {
  const changes: EmployeeFieldChange[] = []
  for (const key of Object.keys(next)) {
    const before = norm(current[key])
    const after = norm(next[key])
    if (before !== after) {
      changes.push({ field: key, label: fieldLabel(key), from: current[key] ?? null, to: next[key] ?? null })
    }
  }
  return changes
}

let ensured: Promise<void> | null = null

/**
 * Idempotently ensure the events/imports tables and archive columns exist.
 * Mirrors the ensure* pattern used elsewhere (e.g. ensurePermissionSchema) so
 * the feature works even before the SQL migration is applied by hand.
 */
export function ensureEmployeeEventsSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS hr_employee_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      employee_id INT UNSIGNED NOT NULL,
      employee_ref VARCHAR(50) DEFAULT NULL,
      employee_name VARCHAR(150) DEFAULT NULL,
      event_type VARCHAR(60) NOT NULL,
      summary VARCHAR(255) NOT NULL,
      changes JSON DEFAULT NULL,
      actor_id INT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hr_event_employee (employee_id, created_at),
      KEY idx_hr_event_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS hr_employee_imports (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      file_name VARCHAR(255) DEFAULT NULL,
      total_rows INT UNSIGNED NOT NULL DEFAULT 0,
      imported INT UNSIGNED NOT NULL DEFAULT 0,
      failed INT UNSIGNED NOT NULL DEFAULT 0,
      skipped INT UNSIGNED NOT NULL DEFAULT 0,
      errors JSON DEFAULT NULL,
      actor_id INT UNSIGNED DEFAULT NULL,
      actor_name VARCHAR(150) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hr_import_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  } catch (error) {
    console.error("[v0] ensureEmployeeEventsSchema (tables) failed:", (error as Error).message)
  }

  // Archive columns — added individually so one existing column doesn't abort
  // the rest. ADD COLUMN IF NOT EXISTS is a no-op when already present.
  for (const column of [
    "ADD COLUMN IF NOT EXISTS `archived_at` DATETIME DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `archived_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN IF NOT EXISTS `status_changed_at` DATETIME DEFAULT NULL",
  ]) {
    try {
      await query(`ALTER TABLE hr_employees ${column}`)
    } catch {
      // Column already exists on a server that doesn't support IF NOT EXISTS.
    }
  }
}

export async function logEmployeeEvent(opts: {
  employeeId: number
  employeeRef?: string | null
  employeeName?: string | null
  type: EmployeeEventType
  summary: string
  changes?: EmployeeFieldChange[] | null
  actorId?: number | null
  actorName?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO hr_employee_events
         (employee_id, employee_ref, employee_name, event_type, summary, changes, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        opts.employeeId,
        opts.employeeRef ?? null,
        opts.employeeName ?? null,
        opts.type,
        opts.summary,
        opts.changes && opts.changes.length ? JSON.stringify(opts.changes) : null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    // Never let audit logging break the primary operation.
    console.error("[v0] logEmployeeEvent failed:", (error as Error).message)
  }
}

export async function recordImportRun(opts: {
  fileName?: string | null
  totalRows: number
  imported: number
  failed: number
  skipped: number
  errors?: string[] | null
  actorId?: number | null
  actorName?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO hr_employee_imports
         (file_name, total_rows, imported, failed, skipped, errors, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        opts.fileName ?? null,
        opts.totalRows,
        opts.imported,
        opts.failed,
        opts.skipped,
        opts.errors && opts.errors.length ? JSON.stringify(opts.errors) : null,
        opts.actorId ?? null,
        opts.actorName ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] recordImportRun failed:", (error as Error).message)
  }
}
