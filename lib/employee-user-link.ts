import "server-only"

import { query } from "@/lib/db"
import { getCurrentActor } from "@/lib/actor-context"
import {
  type AccountType,
  type LinkRelation,
  type UserAccessStatus,
  classifyLink,
  deriveAccessStatus,
  relationLabel,
  validateLink,
} from "@/lib/employee-user-link-core"

/**
 * SPEC 15 — Employee ⇄ User link: DB layer.
 *
 * Builds on the pure model in `employee-user-link-core.ts`. Responsibilities:
 *   - self-heal the schema (account_type / user_id / entity_id / audit table),
 *   - read the mapping console (employees, lone users, audit events, stats),
 *   - mutate links (link / unlink / mark service account), and
 *   - synchronize a user's ACCESS STATUS from the employment records linked to
 *     it, which is what offboarding and inter-entity transfers hook into.
 *
 * Users are tenant-scoped (users.tenant_id); `hr_employees` is tenant-global in
 * this ERP, so employee reads are not tenant-filtered but every link is only
 * ever made to a user inside the acting tenant.
 */

export class LinkError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "LinkError"
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Schema (self-healing, additive only)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null
export function ensureEmployeeUserLinkSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function safeExec(sql: string): Promise<void> {
  try {
    await query(sql)
  } catch {
    // Column/index already present on servers without IF NOT EXISTS support.
  }
}

async function doEnsure(): Promise<void> {
  await safeExec("ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `account_type` VARCHAR(20) NOT NULL DEFAULT 'person'")
  await safeExec("ALTER TABLE `hr_employees` ADD COLUMN IF NOT EXISTS `user_id` INT UNSIGNED DEFAULT NULL")
  await safeExec("ALTER TABLE `hr_employees` ADD COLUMN IF NOT EXISTS `entity_id` INT UNSIGNED DEFAULT NULL")
  await safeExec("ALTER TABLE `hr_employees` ADD INDEX IF NOT EXISTS `idx_hr_user` (`user_id`)")
  await safeExec("ALTER TABLE `hr_employees` ADD INDEX IF NOT EXISTS `idx_hr_entity` (`entity_id`)")
  await safeExec(`CREATE TABLE IF NOT EXISTS employee_user_link_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED DEFAULT NULL,
    employee_pk INT UNSIGNED DEFAULT NULL,
    user_id INT UNSIGNED DEFAULT NULL,
    action VARCHAR(40) NOT NULL,
    detail JSON DEFAULT NULL,
    actor_id INT UNSIGNED DEFAULT NULL,
    actor_name VARCHAR(150) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_eul_tenant (tenant_id, created_at),
    KEY idx_eul_user (user_id),
    KEY idx_eul_emp (employee_pk)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

let lifecycleColumnCache: boolean | null = null
async function hasLifecycleColumn(): Promise<boolean> {
  if (lifecycleColumnCache !== null) return lifecycleColumnCache
  try {
    const rows = await query<{ c: number }[]>(
      `SELECT COUNT(*) c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'lifecycle_state'`,
    )
    lifecycleColumnCache = Number(rows[0]?.c ?? 0) > 0
  } catch {
    lifecycleColumnCache = false
  }
  return lifecycleColumnCache
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * True when an employment record is closed for access-derivation purposes:
 * either it has been formally exited (`exit_status = 'Exited'`) or soft-archived
 * off the active roster (`archived_at` set). A soft-archived employee should not
 * keep its login active on its own, matching `deriveAccessStatus`.
 */
function employeeArchived(row: { exit_status?: unknown; archived_at?: unknown }): boolean {
  if (String(row.exit_status ?? "").trim().toLowerCase() === "exited") return true
  return row.archived_at != null && String(row.archived_at).trim() !== ""
}

async function logLinkEvent(opts: {
  tenantId: number | null
  employeePk?: number | null
  userId?: number | null
  action: string
  detail?: Record<string, unknown> | null
}): Promise<void> {
  const actor = getCurrentActor()
  try {
    await query(
      `INSERT INTO employee_user_link_events (tenant_id, employee_pk, user_id, action, detail, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?)`,
      [
        opts.tenantId ?? null,
        opts.employeePk ?? null,
        opts.userId ?? null,
        opts.action,
        opts.detail ? JSON.stringify(opts.detail) : null,
        actor?.userId ?? null,
        actor?.name ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] logLinkEvent failed:", (error as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type EmployeeLinkRow = {
  employeePk: number
  employeeCode: string
  employeeName: string
  department: string | null
  designation: string | null
  employmentStatus: string | null
  entityId: number | null
  archived: boolean
  relation: LinkRelation
  relationLabel: string
  relationTone: "ok" | "warn" | "muted" | "info"
  user: { id: number; name: string; email: string; role: string; status: string; accountType: AccountType } | null
}

export type LoneUserRow = {
  id: number
  name: string
  email: string
  role: string
  status: string
  accountType: AccountType
  relation: LinkRelation
  relationLabel: string
  relationTone: "ok" | "warn" | "muted" | "info"
}

export type LinkEventRow = {
  id: number
  employeePk: number | null
  userId: number | null
  action: string
  detail: Record<string, unknown> | null
  actorName: string | null
  createdAt: string
}

export type LinkableUser = { id: number; name: string; email: string; linkedCount: number }

export type LinkOverview = {
  employees: EmployeeLinkRow[]
  loneUsers: LoneUserRow[]
  linkableUsers: LinkableUser[]
  events: LinkEventRow[]
  stats: {
    linked: number
    historical: number
    unlinkedEmployees: number
    unlinkedUsers: number
    serviceAccounts: number
    outOfSync: number
  }
}

function tenantUserFilter(alias: string): string {
  // Legacy rows may predate multi-tenancy (tenant_id NULL); include them.
  return `(${alias}.tenant_id = ? OR ${alias}.tenant_id IS NULL)`
}

export async function listEmployeeLinks(tenantId: number): Promise<EmployeeLinkRow[]> {
  await ensureEmployeeUserLinkSchema()
  const rows = await query<any[]>(
    `SELECT e.id AS employeePk, e.employee_id AS employeeCode, e.employee_name AS employeeName,
            e.department, e.designation, e.employment_status AS employmentStatus,
            e.entity_id AS entityId, e.exit_status AS exitStatus, e.archived_at AS archivedAt,
            u.id AS userId, u.name AS userName, u.email AS userEmail,
            u.role AS userRole, u.status AS userStatus, u.account_type AS accountType
       FROM hr_employees e
       LEFT JOIN users u ON u.id = e.user_id AND ${tenantUserFilter("u")}
      ORDER BY e.employee_name ASC, e.id ASC`,
    [tenantId],
  )
  return rows.map((r) => {
    const archived = employeeArchived({ exit_status: r.exitStatus, archived_at: r.archivedAt })
    const user = r.userId
      ? {
          id: Number(r.userId),
          name: r.userName,
          email: r.userEmail,
          role: r.userRole,
          status: r.userStatus,
          accountType: (r.accountType === "service" ? "service" : "person") as AccountType,
        }
      : null
    const relation = classifyLink({
      employee: { employmentStatus: r.employmentStatus, archived },
      user: user ? { accountType: user.accountType } : null,
    })
    const meta = relationLabel(relation)
    return {
      employeePk: Number(r.employeePk),
      employeeCode: r.employeeCode,
      employeeName: r.employeeName,
      department: r.department ?? null,
      designation: r.designation ?? null,
      employmentStatus: r.employmentStatus ?? null,
      entityId: r.entityId != null ? Number(r.entityId) : null,
      archived,
      relation,
      relationLabel: meta.label,
      relationTone: meta.tone,
      user,
    }
  })
}

export async function listLoneUsers(tenantId: number): Promise<LoneUserRow[]> {
  await ensureEmployeeUserLinkSchema()
  const rows = await query<any[]>(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.account_type AS accountType
       FROM users u
      WHERE ${tenantUserFilter("u")}
        AND u.id NOT IN (SELECT user_id FROM hr_employees WHERE user_id IS NOT NULL)
      ORDER BY u.name ASC`,
    [tenantId],
  )
  return rows.map((r) => {
    const accountType = (r.accountType === "service" ? "service" : "person") as AccountType
    const relation = classifyLink({ employee: null, user: { accountType } })
    const meta = relationLabel(relation)
    return {
      id: Number(r.id),
      name: r.name,
      email: r.email,
      role: r.role,
      status: r.status,
      accountType,
      relation,
      relationLabel: meta.label,
      relationTone: meta.tone,
    }
  })
}

export async function listLinkableUsers(tenantId: number): Promise<LinkableUser[]> {
  await ensureEmployeeUserLinkSchema()
  const rows = await query<any[]>(
    `SELECT u.id, u.name, u.email,
            (SELECT COUNT(*) FROM hr_employees e WHERE e.user_id = u.id) AS linkedCount
       FROM users u
      WHERE ${tenantUserFilter("u")} AND u.account_type <> 'service'
      ORDER BY u.name ASC`,
    [tenantId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    email: r.email,
    linkedCount: Number(r.linkedCount ?? 0),
  }))
}

export async function listLinkEvents(tenantId: number, limit = 100): Promise<LinkEventRow[]> {
  await ensureEmployeeUserLinkSchema()
  const rows = await query<any[]>(
    `SELECT id, employee_pk AS employeePk, user_id AS userId, action, detail, actor_name AS actorName, created_at AS createdAt
       FROM employee_user_link_events
      WHERE tenant_id = ? OR tenant_id IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [tenantId, Math.max(1, Math.min(500, limit))],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    employeePk: r.employeePk != null ? Number(r.employeePk) : null,
    userId: r.userId != null ? Number(r.userId) : null,
    action: r.action,
    detail: parseDetail(r.detail),
    actorName: r.actorName ?? null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(r.createdAt).toISOString(),
  }))
}

function parseDetail(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === "object") return raw as Record<string, unknown>
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

export async function getLinkOverview(tenantId: number): Promise<LinkOverview> {
  const [employees, loneUsers, linkableUsers, events] = await Promise.all([
    listEmployeeLinks(tenantId),
    listLoneUsers(tenantId),
    listLinkableUsers(tenantId),
    listLinkEvents(tenantId, 100),
  ])

  // Out-of-sync = a linked user whose current access status doesn't match the
  // status derived from the employment records pointing at it.
  const byUser = new Map<number, { status: string; employees: EmployeeLinkRow[] }>()
  for (const e of employees) {
    if (!e.user) continue
    const bucket = byUser.get(e.user.id) ?? { status: e.user.status, employees: [] }
    bucket.employees.push(e)
    byUser.set(e.user.id, bucket)
  }
  let outOfSync = 0
  for (const [, bucket] of byUser) {
    const derived = deriveAccessStatus(
      bucket.employees.map((e) => ({ employmentStatus: e.employmentStatus, archived: e.archived })),
    )
    const current: UserAccessStatus = bucket.status === "active" ? "active" : "inactive"
    if (current !== derived) outOfSync++
  }

  return {
    employees,
    loneUsers,
    linkableUsers,
    events,
    stats: {
      linked: employees.filter((e) => e.relation === "linked").length,
      historical: employees.filter((e) => e.relation === "historical").length,
      unlinkedEmployees: employees.filter((e) => e.relation === "unlinked_employee").length,
      unlinkedUsers: loneUsers.filter((u) => u.relation === "unlinked_user").length,
      serviceAccounts: loneUsers.filter((u) => u.relation === "service_account").length,
      outOfSync,
    },
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function loadEmployee(employeePk: number): Promise<{ id: number; user_id: number | null; entity_id: number | null; employee_name: string } | null> {
  const rows = await query<any[]>(
    "SELECT id, user_id, entity_id, employee_name FROM hr_employees WHERE id = ? LIMIT 1",
    [employeePk],
  )
  return rows[0] ?? null
}

async function loadTenantUser(
  tenantId: number,
  userId: number,
): Promise<{ id: number; name: string; account_type: AccountType } | null> {
  const rows = await query<any[]>(
    `SELECT id, name, account_type FROM users WHERE id = ? AND ${tenantUserFilter("users")} LIMIT 1`,
    [userId, tenantId],
  )
  const row = rows[0]
  if (!row) return null
  return { id: Number(row.id), name: row.name, account_type: row.account_type === "service" ? "service" : "person" }
}

export async function linkEmployeeToUser(
  tenantId: number,
  employeePk: number,
  userId: number,
): Promise<{ ok: true }> {
  await ensureEmployeeUserLinkSchema()
  const employee = await loadEmployee(employeePk)
  if (!employee) throw new LinkError("Employee not found", 404)

  const user = await loadTenantUser(tenantId, userId)
  if (!user) throw new LinkError("User not found in this tenant", 404)

  // Employees already linked to this user WITHIN THE SAME entity (null-safe so
  // two unassigned employees also count as the same bucket).
  const dupes = await query<any[]>(
    "SELECT id FROM hr_employees WHERE user_id = ? AND id <> ? AND (entity_id <=> ?)",
    [userId, employeePk, employee.entity_id],
  )

  const result = validateLink({
    employeeCurrentUserId: employee.user_id,
    targetUserId: userId,
    targetAccountType: user.account_type,
    sameEntityEmployeeIds: dupes.map((d) => Number(d.id)),
  })
  if (!result.ok) throw new LinkError(result.error, 409)

  await query("UPDATE hr_employees SET user_id = ? WHERE id = ?", [userId, employeePk])
  await logLinkEvent({
    tenantId,
    employeePk,
    userId,
    action: "linked",
    detail: { employeeName: employee.employee_name, userName: user.name, entityId: employee.entity_id },
  })
  await syncAccessStatusForUser(tenantId, userId)
  return { ok: true }
}

export async function unlinkEmployee(tenantId: number, employeePk: number): Promise<{ ok: true }> {
  await ensureEmployeeUserLinkSchema()
  const employee = await loadEmployee(employeePk)
  if (!employee) throw new LinkError("Employee not found", 404)
  const previousUserId = employee.user_id

  await query("UPDATE hr_employees SET user_id = NULL WHERE id = ?", [employeePk])
  await logLinkEvent({
    tenantId,
    employeePk,
    userId: previousUserId,
    action: "unlinked",
    detail: { employeeName: employee.employee_name },
  })
  // Re-derive the ex-linked user's access from whatever employment records
  // remain (covers the multi-entity case: still active elsewhere).
  if (previousUserId != null) await syncAccessStatusForUser(tenantId, previousUserId)
  return { ok: true }
}

export async function setUserAccountType(
  tenantId: number,
  userId: number,
  accountType: AccountType,
): Promise<{ ok: true }> {
  await ensureEmployeeUserLinkSchema()
  const user = await loadTenantUser(tenantId, userId)
  if (!user) throw new LinkError("User not found in this tenant", 404)

  if (accountType === "service") {
    const linked = await query<any[]>("SELECT id FROM hr_employees WHERE user_id = ? LIMIT 1", [userId])
    if (linked.length > 0) {
      throw new LinkError("Unlink all employees before marking this login as a service account.", 409)
    }
  }

  await query(`UPDATE users SET account_type = ? WHERE id = ? AND ${tenantUserFilter("users")}`, [
    accountType,
    userId,
    tenantId,
  ])
  await logLinkEvent({
    tenantId,
    userId,
    action: "account_type_changed",
    detail: { userName: user.name, accountType },
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Access-status synchronization
// ---------------------------------------------------------------------------

export type SyncResult = {
  userId: number
  skipped: boolean
  changed: boolean
  from?: UserAccessStatus
  to?: UserAccessStatus
}

/**
 * Recompute a single user's ACCESS STATUS from the employment records linked to
 * it and persist any change. Users with no linked employee (service accounts,
 * standalone admins) are left untouched — this never revokes a login that isn't
 * governed by employment. This is the primitive offboarding/transfer calls.
 */
export async function syncAccessStatusForUser(tenantId: number, userId: number): Promise<SyncResult> {
  await ensureEmployeeUserLinkSchema()

  const userRows = await query<any[]>(
    `SELECT id, status, account_type FROM users WHERE id = ? AND ${tenantUserFilter("users")} LIMIT 1`,
    [userId, tenantId],
  )
  const user = userRows[0]
  if (!user) return { userId, skipped: true, changed: false }
  // Service accounts are intentionally employee-less; never governed here.
  if (user.account_type === "service") return { userId, skipped: true, changed: false }

  const linked = await query<any[]>(
    "SELECT employment_status AS employmentStatus, exit_status AS exitStatus, archived_at AS archivedAt FROM hr_employees WHERE user_id = ?",
    [userId],
  )
  if (linked.length === 0) return { userId, skipped: true, changed: false }

  const derived = deriveAccessStatus(
    linked.map((e) => ({
      employmentStatus: e.employmentStatus,
      archived: employeeArchived({ exit_status: e.exitStatus, archived_at: e.archivedAt }),
    })),
  )
  const current: UserAccessStatus = user.status === "active" ? "active" : "inactive"

  const applied = await applyAccessStatus(userId, derived, current)
  if (applied.changed) {
    await logLinkEvent({
      tenantId,
      userId,
      action: "access_synced",
      detail: { from: current, to: derived, linkedEmployees: linked.length },
    })
  }
  return { userId, skipped: false, changed: applied.changed, from: current, to: derived }
}

/**
 * Persist the derived access status. Keeps the SPEC 14 lifecycle_state (when
 * present) in step WITHOUT trampling a manual suspension or a pending
 * invitation: employment ending deactivates an otherwise-active login, and an
 * employment reactivation only rehires a login that was previously
 * auto-deactivated.
 */
async function applyAccessStatus(
  userId: number,
  derived: UserAccessStatus,
  current: UserAccessStatus,
): Promise<{ changed: boolean }> {
  const lifecycle = await hasLifecycleColumn()

  if (derived === "inactive") {
    if (current !== "active") return { changed: false }
    if (lifecycle) {
      try {
        await query(
          `UPDATE users SET status = 'inactive', lifecycle_state = 'deactivated',
                            deactivated_at = NOW(), deactivated_reason = 'Employment ended (auto-sync)'
            WHERE id = ? AND lifecycle_state = 'active'`,
          [userId],
        )
        // If the user was active-but-not-lifecycle-active (e.g. legacy), still
        // mirror the coarse status flag.
        await query("UPDATE users SET status = 'inactive' WHERE id = ? AND status = 'active'", [userId])
        return { changed: true }
      } catch {
        // lifecycle columns unexpectedly absent — fall through to status-only.
      }
    }
    await query("UPDATE users SET status = 'inactive' WHERE id = ? AND status = 'active'", [userId])
    return { changed: true }
  }

  // derived === "active"
  if (current === "active") return { changed: false }
  if (lifecycle) {
    try {
      const res = await query<any>(
        `UPDATE users SET status = 'active', lifecycle_state = 'active',
                          deactivated_at = NULL, deactivated_reason = NULL
          WHERE id = ? AND lifecycle_state = 'deactivated'`,
        [userId],
      )
      // Only report a change when a previously auto-deactivated login was
      // actually reactivated; a suspended/invited login is deliberately left
      // inactive and must be handled through the lifecycle console.
      const affected = Number((res as any)?.affectedRows ?? 0)
      return { changed: affected > 0 }
    } catch {
      // fall through
    }
  }
  await query("UPDATE users SET status = 'active' WHERE id = ? AND status <> 'active'", [userId])
  return { changed: true }
}

/**
 * Re-derive access for the user linked to a given employee. Offboarding and
 * transfer flows call this by employee primary key without needing to know the
 * user id or tenant. Resolves the tenant from the linked user itself.
 */
export async function syncAccessStatusForEmployee(employeePk: number): Promise<SyncResult | null> {
  await ensureEmployeeUserLinkSchema()
  const rows = await query<any[]>(
    `SELECT e.user_id AS userId, u.tenant_id AS tenantId
       FROM hr_employees e JOIN users u ON u.id = e.user_id
      WHERE e.id = ? LIMIT 1`,
    [employeePk],
  )
  const row = rows[0]
  if (!row?.userId) return null
  // tenant_id may be NULL on legacy single-tenant rows; syncAccessStatusForUser
  // tolerates that via the tenantUserFilter.
  return syncAccessStatusForUser(Number(row.tenantId ?? 0), Number(row.userId))
}

/** Re-derive access for every login governed by at least one employee. */
export async function syncAllAccessStatuses(tenantId: number): Promise<{ scanned: number; changed: number }> {
  await ensureEmployeeUserLinkSchema()
  const rows = await query<any[]>(
    `SELECT DISTINCT e.user_id AS userId
       FROM hr_employees e JOIN users u ON u.id = e.user_id
      WHERE e.user_id IS NOT NULL AND ${tenantUserFilter("u")} AND u.account_type <> 'service'`,
    [tenantId],
  )
  let changed = 0
  for (const r of rows) {
    const res = await syncAccessStatusForUser(tenantId, Number(r.userId))
    if (res.changed) changed++
  }
  return { scanned: rows.length, changed }
}
