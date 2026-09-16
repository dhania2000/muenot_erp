import "server-only"
import { query } from "@/lib/db"

/**
 * Phase 59 — Recruiter / Hiring manager / Interviewer ⇄ Employee Master.
 *
 * The recruitment "person" fields used to be free-typed strings (a recruiter's
 * name typed into `recruit_jobs.recruiter`, an interviewer's name into
 * `recruit_interviews.interviewer`). Two people with the same name, a rename,
 * or a typo all silently forked the identity. This module resolves those names
 * against the HR Employee Master (the single source of truth) and lets callers
 * store a STABLE employee id (the business code `hr_employees.employee_id`, e.g.
 * "EMP-0042") alongside the name. The display name can then always be DERIVED
 * from the stored id, so a later rename in HR flows through automatically.
 *
 * Everything is best-effort: on an install without the HR master (or a name we
 * cannot match) resolution returns nulls and the caller keeps the free-text
 * value exactly as before — this never blocks a recruitment write.
 */

export type EmployeeRef = {
  /** Stable business code — `hr_employees.employee_id` (e.g. "EMP-0042"). */
  employeeId: string | null
  /** Canonical name from the employee record. */
  employeeName: string | null
  /** Work email (official, then personal) for calendar invites / notifications. */
  email: string | null
  /** Linked application user id, when the employee has a login. */
  userId: number | null
}

const EMPTY: EmployeeRef = { employeeId: null, employeeName: null, email: null, userId: null }

/** Small per-process caches — recruitment writes resolve the same few names a lot. */
const refCache = new Map<string, EmployeeRef>()
const nameCache = new Map<string, string | null>()

/**
 * Resolve a free-text recruiter / hiring-manager / interviewer value against
 * the HR Employee Master. Matches on the stable code first (so an already-
 * resolved id round-trips), then falls back to a case-insensitive name match,
 * preferring an active employee over an exited one. Returns {@link EMPTY} when
 * nothing matches.
 */
export async function resolveEmployeeRef(value: unknown): Promise<EmployeeRef> {
  const raw = String(value ?? "").trim()
  if (!raw) return EMPTY
  const key = raw.toLowerCase()
  const cached = refCache.get(key)
  if (cached) return cached

  let ref: EmployeeRef = EMPTY
  try {
    // 1. Exact stable-code match (value is already an employee id).
    let rows = (await query(
      `SELECT employee_id, employee_name,
              COALESCE(NULLIF(official_email, ''), personal_email) AS email, user_id
         FROM hr_employees
        WHERE employee_id = ?
        LIMIT 1`,
      [raw],
    )) as any[]

    // 2. Fall back to a name match, preferring a still-active employee.
    if (!rows.length) {
      rows = (await query(
        `SELECT employee_id, employee_name,
                COALESCE(NULLIF(official_email, ''), personal_email) AS email, user_id
           FROM hr_employees
          WHERE LOWER(employee_name) = LOWER(?)
          ORDER BY (COALESCE(NULLIF(employment_status, ''), 'Active')
                     NOT IN ('Inactive', 'Resigned', 'Terminated', 'Exited')) DESC
          LIMIT 1`,
        [raw],
      )) as any[]
    }

    if (rows.length) {
      const r = rows[0]
      ref = {
        employeeId: r.employee_id != null && r.employee_id !== "" ? String(r.employee_id) : null,
        employeeName: r.employee_name ? String(r.employee_name) : null,
        email: r.email ? String(r.email) : null,
        userId: r.user_id != null ? Number(r.user_id) : null,
      }
    }
  } catch {
    // HR master missing / not migrated — leave the caller's free text untouched.
    ref = EMPTY
  }
  refCache.set(key, ref)
  return ref
}

/**
 * Derive the display name for a stored stable employee id. Returns null when the
 * id no longer resolves (the caller then falls back to any stored name string).
 */
export async function deriveEmployeeName(employeeId: unknown): Promise<string | null> {
  const code = String(employeeId ?? "").trim()
  if (!code) return null
  if (nameCache.has(code)) return nameCache.get(code)!
  let name: string | null = null
  try {
    const rows = (await query(
      `SELECT employee_name FROM hr_employees WHERE employee_id = ? LIMIT 1`,
      [code],
    )) as any[]
    name = rows[0]?.employee_name ? String(rows[0].employee_name) : null
  } catch {
    name = null
  }
  nameCache.set(code, name)
  return name
}

/** Tables whose stable-id columns have already been ensured this process. */
const ensuredColumns = new Set<string>()

/**
 * Idempotently add the given stable-id columns (VARCHAR, nullable) to a table.
 * Mirrors the `ADD COLUMN IF NOT EXISTS` self-heal used across the recruitment
 * schema so an older install gains the column on first write. Best-effort.
 */
export async function ensureEmployeeRefColumns(table: string, columns: string[]): Promise<void> {
  for (const col of columns) {
    const marker = `${table}.${col}`
    if (ensuredColumns.has(marker)) continue
    try {
      await query(`ALTER TABLE \`${table}\` ADD COLUMN IF NOT EXISTS \`${col}\` VARCHAR(64) DEFAULT NULL`)
    } catch {
      // Column already exists / table not present / engine lacks IF NOT EXISTS.
    }
    ensuredColumns.add(marker)
  }
}

/**
 * Resolve a person field and return the value patch to persist: the derived
 * canonical `name` (when matched) plus the stable `id`. When nothing resolves,
 * the id is null and the name is the caller's original trimmed value, so the
 * free-text behaviour is preserved.
 */
export async function resolvePersonField(
  value: unknown,
): Promise<{ name: string | null; employeeId: string | null }> {
  const raw = String(value ?? "").trim() || null
  const ref = await resolveEmployeeRef(value)
  return {
    name: ref.employeeName ?? raw,
    employeeId: ref.employeeId,
  }
}
