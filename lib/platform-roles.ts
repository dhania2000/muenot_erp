import "server-only"
/**
 * Platform/tenant role persistence, resolution and audit.
 * ---------------------------------------------------------------------------
 * Server-side source of truth for the two role axes defined in
 * lib/role-model.ts. Mirrors database/migrations/2026-11-08-platform-tenant-roles.sql
 * with a runtime self-heal (same pattern as lib/tenant-service.ts) so existing
 * installs converge without a manual migration step.
 *
 * The pure boundary rules live in lib/role-model.ts; this module only loads the
 * stored roles, resolves a RoleContext for a session, and performs role changes
 * / impersonation transitions with the escalation checks and audit logging that
 * Phase 4 needs as evidence.
 */
import { query } from "@/lib/db"
import {
  type PlatformRole,
  type RoleContext,
  type TenantRole,
  canAssignPlatformRole,
  canAssignTenantRole,
  toPlatformRole,
  toTenantRole,
} from "@/lib/role-model"
import { DEFAULT_TENANT_SLUG, ensureTenantSchema, getTenantById } from "@/lib/tenant-service"

let ensured: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}
async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )
  return rows.length > 0
}

async function runEnsure(): Promise<void> {
  await ensureTenantSchema() // guarantees tenants + users.tenant_id exist

  if (!(await columnExists("users", "platform_role"))) {
    await query(
      "ALTER TABLE `users` ADD COLUMN `platform_role` ENUM('none','platform_staff','platform_super_admin') NOT NULL DEFAULT 'none' AFTER `role`",
    )
  }
  if (!(await columnExists("users", "tenant_role"))) {
    await query(
      "ALTER TABLE `users` ADD COLUMN `tenant_role` ENUM('employee','module_admin','tenant_admin','tenant_owner') NOT NULL DEFAULT 'employee' AFTER `platform_role`",
    )
  }
  if (!(await indexExists("users", "idx_users_platform_role"))) {
    await query("ALTER TABLE `users` ADD KEY `idx_users_platform_role` (`platform_role`)")
  }
  if (!(await indexExists("users", "idx_users_tenant_role"))) {
    await query("ALTER TABLE `users` ADD KEY `idx_users_tenant_role` (`tenant_role`)")
  }

  // Backfill tenant_role from the legacy coarse role for rows still at default.
  await query("UPDATE `users` SET `tenant_role` = 'tenant_admin' WHERE `role` = 'admin' AND `tenant_role` = 'employee'")

  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_admin_audit\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`actor_user_id\` INT UNSIGNED NOT NULL,
      \`actor_email\` VARCHAR(190) DEFAULT NULL,
      \`action\` VARCHAR(64) NOT NULL,
      \`target_user_id\` INT UNSIGNED DEFAULT NULL,
      \`target_tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`detail\` JSON DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_paa_actor\` (\`actor_user_id\`),
      KEY \`idx_paa_action\` (\`action\`),
      KEY \`idx_paa_target_tenant\` (\`target_tenant_id\`),
      KEY \`idx_paa_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Supports tenant-scoped audit-separation queries: "show every platform
  // action taken against tenant X" (Spec62, #242-244) reads the platform audit
  // trail alone, never a customer tenant's own audit log.
  if (!(await indexExists("platform_admin_audit", "idx_paa_target_tenant_action"))) {
    await query(
      "ALTER TABLE `platform_admin_audit` ADD KEY `idx_paa_target_tenant_action` (`target_tenant_id`, `action`)",
    )
  }

  // Bootstrap one platform operator if none exists (mirrors the migration).
  const [{ n } = { n: 0 }] = await query<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM `users` WHERE `platform_role` = 'platform_super_admin'",
  )
  if (Number(n) === 0) {
    await query(
      `UPDATE \`users\` u
         JOIN \`tenants\` t ON t.id = u.tenant_id
          SET u.platform_role = 'platform_super_admin'
        WHERE t.is_platform_owner = 1 AND u.role = 'admin' AND u.status = 'active'
        ORDER BY u.id ASC
        LIMIT 1`,
    )
  }
}

/** Ensure the role columns / audit table exist. Cached per process. */
export async function ensurePlatformRoleSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

export type StoredRoles = {
  userId: number
  tenantId: number | null
  platformRole: PlatformRole
  tenantRole: TenantRole
}

/** Load the stored role axes for a user straight from the source of truth. */
export async function getStoredRoles(userId: number): Promise<StoredRoles | null> {
  await ensurePlatformRoleSchema()
  const rows = await query<
    { tenant_id: number | null; platform_role: string; tenant_role: string; role: string }[]
  >("SELECT `tenant_id`, `platform_role`, `tenant_role`, `role` FROM `users` WHERE `id` = ? LIMIT 1", [userId])
  const row = rows[0]
  if (!row) return null
  return {
    userId,
    tenantId: row.tenant_id != null ? Number(row.tenant_id) : null,
    platformRole: toPlatformRole(row.platform_role),
    // Fall back to deriving from the legacy role for any row that predates the
    // backfill, so authorization is never weaker than the legacy check.
    tenantRole: toTenantRole(row.tenant_role || (row.role === "admin" ? "tenant_admin" : "employee")),
  }
}

/**
 * Resolve the full RoleContext a request acts under. `impersonatedTenantId`
 * comes from the verified session (never client input) and is validated here:
 * only a platform operator may carry one, and only for a tenant that exists and
 * is not their own home tenant. Anything else is ignored (fail closed to the
 * home tenant), so a forged token field can never widen access.
 */
export async function resolveRoleContext(session: {
  userId: number
  impersonatedTenantId?: number | null
}): Promise<RoleContext | null> {
  const stored = await getStoredRoles(session.userId)
  if (!stored) return null

  const homeTenant = stored.tenantId != null ? await getTenantById(stored.tenantId) : null
  const isPlatformOwnerTenant = Boolean(homeTenant?.is_platform_owner)

  let impersonatedTenantId: number | null = null
  const requested = session.impersonatedTenantId
  if (requested != null && stored.platformRole !== "none" && requested !== stored.tenantId) {
    const target = await getTenantById(requested)
    if (target && target.status === "active") impersonatedTenantId = target.id
  }

  return {
    userId: stored.userId,
    homeTenantId: stored.tenantId,
    isPlatformOwnerTenant,
    platformRole: stored.platformRole,
    tenantRole: stored.tenantRole,
    impersonatedTenantId,
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function recordPlatformAudit(entry: {
  actorUserId: number
  actorEmail?: string | null
  action: string
  targetUserId?: number | null
  targetTenantId?: number | null
  detail?: Record<string, unknown> | null
}): Promise<void> {
  await ensurePlatformRoleSchema()
  try {
    await query(
      `INSERT INTO \`platform_admin_audit\`
         (\`actor_user_id\`, \`actor_email\`, \`action\`, \`target_user_id\`, \`target_tenant_id\`, \`detail\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.actorUserId,
        entry.actorEmail ?? null,
        entry.action,
        entry.targetUserId ?? null,
        entry.targetTenantId ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ],
    )
  } catch (err) {
    // Never let audit failure block the primary action, but make it loud.
    console.error("[platform-roles] audit write failed:", err)
  }
}

// ---------------------------------------------------------------------------
// Role assignment (escalation-checked)
// ---------------------------------------------------------------------------

// Relative severity of tenant roles, so a role change can be classed as an
// escalation (higher) vs. a demotion (lower) for security alerting.
const SEVERITY_OF_TENANT_ROLE: Record<TenantRole, number> = {
  employee: 0,
  module_admin: 1,
  tenant_admin: 2,
  tenant_owner: 3,
}

/** Human-friendly label (email, else name) for a user, for alert subjects. */
async function getUserLabel(userId: number): Promise<string> {
  const rows = await query<{ email: string | null; name: string | null }[]>(
    "SELECT `email`, `name` FROM `users` WHERE `id` = ? LIMIT 1",
    [userId],
  )
  return rows[0]?.email || rows[0]?.name || `user #${userId}`
}

export class RoleAssignmentError extends Error {
  status: number
  constructor(message: string, status = 403) {
    super(message)
    this.name = "RoleAssignmentError"
    this.status = status
  }
}

/**
 * Assign a platform role to a user. Enforces canAssignPlatformRole (a caller
 * can never grant above their own level, and only a super admin can mint
 * another super admin) and audits the change.
 */
export async function assignPlatformRole(
  actor: RoleContext & { email?: string },
  targetUserId: number,
  role: PlatformRole,
): Promise<void> {
  if (!canAssignPlatformRole(actor, role)) {
    throw new RoleAssignmentError("You are not permitted to grant this platform role")
  }
  await ensurePlatformRoleSchema()
  const before = await getStoredRoles(targetUserId)
  if (!before) throw new RoleAssignmentError("Target user not found", 404)

  await query("UPDATE `users` SET `platform_role` = ? WHERE `id` = ?", [role, targetUserId])
  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "assign_platform_role",
    targetUserId,
    detail: { from: before.platformRole, to: role },
  })

  // Granting platform staff/super-admin is the highest-privilege escalation;
  // alert the target's tenant security admins (best-effort).
  if (role !== "none" && before.platformRole === "none" && before.tenantId != null) {
    const subjectLabel = await getUserLabel(targetUserId)
    void import("@/lib/security-alerts-store").then((m) =>
      m.onRoleEscalation({
        tenantId: before.tenantId as number,
        subjectUserId: targetUserId,
        subjectLabel,
        from: `platform:${before.platformRole}`,
        to: `platform:${role}`,
        actorUserId: actor.userId,
      }),
    )
  }
}

/**
 * Assign a tenant role to a user within a tenant. Enforces canAssignTenantRole
 * (caller must have tenant-admin authority over that exact tenant, can never
 * grant above their own tenant role, and only a real owner can confer
 * ownership) and audits the change. Keeps the legacy `users.role` in sync so
 * existing feature/matrix checks stay correct.
 */
export async function assignTenantRole(
  actor: RoleContext & { email?: string },
  targetUserId: number,
  targetTenantId: number,
  role: TenantRole,
): Promise<void> {
  if (!canAssignTenantRole(actor, targetTenantId, role)) {
    throw new RoleAssignmentError("You are not permitted to grant this tenant role")
  }
  await ensurePlatformRoleSchema()
  const before = await getStoredRoles(targetUserId)
  if (!before) throw new RoleAssignmentError("Target user not found", 404)
  if (before.tenantId !== targetTenantId) {
    // Never move a user across tenants via a role change.
    throw new RoleAssignmentError("Target user does not belong to that tenant", 409)
  }

  const legacy = role === "tenant_admin" || role === "tenant_owner" ? "admin" : "employee"
  await query("UPDATE `users` SET `tenant_role` = ?, `role` = ? WHERE `id` = ?", [role, legacy, targetUserId])
  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "assign_tenant_role",
    targetUserId,
    targetTenantId,
    detail: { from: before.tenantRole, to: role, legacyRole: legacy },
  })

  // Security-alert correlation signals (Spec22). Best-effort — a role change is
  // authoritative regardless of whether alerting succeeds.
  const wasAdmin = before.tenantRole === "tenant_admin" || before.tenantRole === "tenant_owner"
  const isAdmin = role === "tenant_admin" || role === "tenant_owner"
  const subjectLabel = await getUserLabel(targetUserId)
  if (isAdmin && !wasAdmin) {
    void import("@/lib/security-alerts-store").then((m) =>
      m.onNewAdmin({ tenantId: targetTenantId, subjectUserId: targetUserId, subjectLabel, actorUserId: actor.userId }),
    )
  }
  if (SEVERITY_OF_TENANT_ROLE[role] > SEVERITY_OF_TENANT_ROLE[before.tenantRole]) {
    void import("@/lib/security-alerts-store").then((m) =>
      m.onRoleEscalation({
        tenantId: targetTenantId,
        subjectUserId: targetUserId,
        subjectLabel,
        from: before.tenantRole,
        to: role,
        actorUserId: actor.userId,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Access directory (platform operators + tenant users)
// ---------------------------------------------------------------------------

export type AccessUser = {
  id: number
  name: string
  email: string
  status: string
  tenantId: number | null
  tenantName: string | null
  platformRole: PlatformRole
  tenantRole: TenantRole
}

/**
 * List users for the Access & support screen. Platform operators are surfaced
 * first so support staff can review who holds platform authority. Read-only
 * aggregation; role changes go through assignPlatformRole/assignTenantRole.
 */
export async function listAccessUsers(limit = 200): Promise<AccessUser[]> {
  await ensurePlatformRoleSchema()
  const rows = await query<any[]>(
    `SELECT u.id, u.name, u.email, u.status, u.tenant_id,
            u.platform_role, u.tenant_role, u.role,
            t.name AS tenant_name
       FROM \`users\` u
       LEFT JOIN \`tenants\` t ON t.id = u.tenant_id
      ORDER BY (u.platform_role <> 'none') DESC, u.platform_role DESC, u.name ASC
      LIMIT ?`,
    [Math.max(1, Math.min(500, limit))],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name ?? "",
    email: r.email ?? "",
    status: r.status ?? "active",
    tenantId: r.tenant_id != null ? Number(r.tenant_id) : null,
    tenantName: r.tenant_name ?? null,
    platformRole: toPlatformRole(r.platform_role),
    tenantRole: toTenantRole(r.tenant_role || (r.role === "admin" ? "tenant_admin" : "employee")),
  }))
}

export { DEFAULT_TENANT_SLUG }
