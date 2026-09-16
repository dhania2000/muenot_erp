import { query } from "@/lib/db"

/**
 * Phases 58-60 — Recruitment ⇄ HR master sync.
 *
 * The Recruitment module's "people" and "org" dropdowns (Department, Recruiter,
 * Hiring manager, Interviewer) must resolve against the HR masters that are the
 * organisation's single source of truth, instead of being free-typed strings
 * that drift out of sync:
 *
 *   - Department   → `hr_departments` (active departments)
 *   - Recruiter /  → `hr_employees` (active employees)
 *     Hiring mgr /
 *     Interviewer
 *
 * These helpers return simple, de-duplicated string lists keyed the same way
 * the Recruitment settings option-sets are, so the generic form dialog can
 * populate the selects with no extra UI code. Everything is best-effort: if an
 * HR master table is missing on an older install the caller falls back to the
 * field's static behaviour rather than breaking the form.
 *
 * Option-set keys consumed by `FieldDef.optionsCategory`:
 */
export const HR_DEPARTMENT_OPTION_KEY = "hr_department"
export const HR_RECRUITER_OPTION_KEY = "hr_recruiter"

/** Active department names from the HR Departments master (source of truth). */
export async function getHrDepartmentOptions(): Promise<string[]> {
  const rows = (await query(
    `SELECT department_name AS name
       FROM hr_departments
      WHERE COALESCE(status, 'Active') <> 'Inactive'
        AND department_name IS NOT NULL AND department_name <> ''
      ORDER BY department_name ASC`,
  )) as { name: string }[]
  return dedupe(rows.map((r) => String(r.name)))
}

/**
 * Active employee names from the HR Employees master, used for every
 * recruitment "person" field (recruiter, hiring manager, interviewer). Active
 * is anything other than an explicit exited state, so historical statuses that
 * predate the current set still resolve to the person's name.
 */
export async function getHrEmployeeOptions(): Promise<string[]> {
  const rows = (await query(
    `SELECT employee_name AS name
       FROM hr_employees
      WHERE COALESCE(NULLIF(employment_status, ''), 'Active') NOT IN ('Inactive', 'Resigned', 'Terminated', 'Exited')
        AND employee_name IS NOT NULL AND employee_name <> ''
      ORDER BY employee_name ASC`,
  )) as { name: string }[]
  return dedupe(rows.map((r) => String(r.name)))
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)))
}

/**
 * Build the HR-master option lists for the recruitment option-sets endpoint.
 * Each list is resolved independently and best-effort, so one missing HR table
 * never blanks the others.
 */
export async function getHrMasterOptionSets(): Promise<Record<string, string[]>> {
  const sets: Record<string, string[]> = {}
  const tasks: [string, () => Promise<string[]>][] = [
    [HR_DEPARTMENT_OPTION_KEY, getHrDepartmentOptions],
    [HR_RECRUITER_OPTION_KEY, getHrEmployeeOptions],
  ]
  await Promise.all(
    tasks.map(async ([key, fn]) => {
      try {
        sets[key] = await fn()
      } catch (e) {
        console.error(`[recruit-hr-masters] failed to load ${key}`, e)
        sets[key] = []
      }
    }),
  )
  return sets
}
