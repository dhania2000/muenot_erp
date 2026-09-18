/**
 * SPEC 15 — Employee ⇄ User link: pure model.
 *
 * This module is intentionally DB-free so the mapping rules (classification,
 * status synchronization, and link validation) can be unit-tested in isolation
 * and reused on both the server and the client. The DB layer in
 * `lib/employee-user-link.ts` builds on top of these primitives.
 *
 * The relationship in this ERP is:
 *   - each `hr_employees` row links to AT MOST one login `users` row via
 *     `hr_employees.user_id` (one employee → one user), and
 *   - a single user MAY be referenced by several employee rows when the same
 *     person is employed across multiple legal entities (user → employees).
 *
 * A user with no employee is either a deliberate SERVICE account (integrations,
 * automation, shared system logins) or an UNLINKED user that needs attention.
 * An employee whose linked user's employment has ended is a HISTORICAL link.
 */

export type AccountType = "person" | "service"
export type UserAccessStatus = "active" | "inactive"

/** How an employee/user pair (or a lone record) relates to the other side. */
export type LinkRelation =
  | "linked" // employee ↔ active person user
  | "historical" // employee ↔ user, but employment has ended (kept for records)
  | "service_account" // user flagged as a service account, intentionally has no employee
  | "unlinked_user" // person user with no employee record — needs review
  | "unlinked_employee" // employee with no login account

/**
 * Employment-status values (case-insensitively) that mean the person no longer
 * has an active working relationship, so their login access must be revoked.
 * Everything else (Active, Probation, Notice Period, On Leave, Confirmed, …)
 * keeps the login active.
 */
export const INACTIVE_EMPLOYMENT_STATUSES = [
  "inactive",
  "resigned",
  "terminated",
  "exited",
  "absconded",
  "retired",
  "relieved",
  "separated",
  "left",
  "offboarded",
  "suspended",
] as const

export function normalizeEmploymentStatus(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
}

/**
 * True when the given employment status implies the person is still working
 * (and therefore should retain login access). An empty/unknown status defaults
 * to active, matching the `hr_employees.employment_status` DEFAULT of 'Active'.
 */
export function employmentImpliesActive(employmentStatus: unknown): boolean {
  const s = normalizeEmploymentStatus(employmentStatus)
  if (!s) return true
  return !(INACTIVE_EMPLOYMENT_STATUSES as readonly string[]).includes(s)
}

/**
 * Derive the access status a login SHOULD have from the employment records
 * linked to it. A user is active when ANY linked employee record is still
 * active (covers the multi-entity case: leaving one entity while still employed
 * by another keeps the login live). An archived employee never keeps a login
 * active on its own.
 */
export function deriveAccessStatus(
  linkedEmployees: Array<{ employmentStatus: unknown; archived?: boolean }>,
): UserAccessStatus {
  const anyActive = linkedEmployees.some((e) => !e.archived && employmentImpliesActive(e.employmentStatus))
  return anyActive ? "active" : "inactive"
}

/** True when a user's current access status already matches the derived one. */
export function isAccessStatusInSync(
  current: UserAccessStatus,
  linkedEmployees: Array<{ employmentStatus: unknown; archived?: boolean }>,
): boolean {
  return current === deriveAccessStatus(linkedEmployees)
}

/**
 * Classify a record for the mapping console. `employee` and/or `user` may be
 * absent to describe a lone record on either side.
 */
export function classifyLink(input: {
  employee?: { employmentStatus?: unknown; archived?: boolean } | null
  user?: { accountType?: AccountType } | null
}): LinkRelation {
  const { employee, user } = input
  if (employee && user) {
    const ended = Boolean(employee.archived) || !employmentImpliesActive(employee.employmentStatus)
    return ended ? "historical" : "linked"
  }
  if (user && !employee) {
    return user.accountType === "service" ? "service_account" : "unlinked_user"
  }
  // employee && !user
  return "unlinked_employee"
}

export type LinkValidationInput = {
  /** The user id the employee is currently linked to, if any. */
  employeeCurrentUserId: number | null
  /** The user we want to link this employee to. */
  targetUserId: number
  /** The account type of the target user. */
  targetAccountType: AccountType
  /**
   * Employee ids (other than the one being linked) already linked to the
   * target user WITHIN THE SAME legal entity. Cross-entity links are allowed;
   * a duplicate within one entity is a conflict.
   */
  sameEntityEmployeeIds: number[]
}

export type LinkValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Validate a proposed employee→user link. Enforces:
 *  - a service account may never be linked to an employee,
 *  - an employee already linked to a DIFFERENT user must be unlinked first,
 *  - a user may not be linked twice within the same legal entity.
 */
export function validateLink(input: LinkValidationInput): LinkValidationResult {
  if (input.targetAccountType === "service") {
    return { ok: false, error: "Cannot link a service account to an employee. Service accounts have no employee." }
  }
  if (input.employeeCurrentUserId != null && input.employeeCurrentUserId !== input.targetUserId) {
    return { ok: false, error: "This employee is already linked to a different login. Unlink it first." }
  }
  if (input.sameEntityEmployeeIds.length > 0) {
    return { ok: false, error: "That login is already linked to another employee in this entity." }
  }
  return { ok: true }
}

/** Human-readable label + tone for a relation, used by the admin console. */
export function relationLabel(relation: LinkRelation): { label: string; tone: "ok" | "warn" | "muted" | "info" } {
  switch (relation) {
    case "linked":
      return { label: "Linked", tone: "ok" }
    case "historical":
      return { label: "Historical", tone: "muted" }
    case "service_account":
      return { label: "Service account", tone: "info" }
    case "unlinked_user":
      return { label: "Unlinked login", tone: "warn" }
    case "unlinked_employee":
      return { label: "No login", tone: "warn" }
  }
}
