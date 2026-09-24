import "server-only"
/**
 * Multi-organization membership.
 * ---------------------------------------------------------------------------
 * A user's HOME tenant lives on `users.tenant_id` and is the single source of
 * truth for default scoping (see lib/tenant-service.ts / lib/auth.ts). That
 * model allows a user to belong to exactly ONE organization, which is too
 * narrow for consultants, group finance staff, and platform-adjacent operators
 * who legitimately work across several of a group's organizations.
 *
 * This module adds a `user_tenant_memberships` mapping so one user can be a
 * member of MANY tenants, each with its own tenant_role, and can then switch
 * the ACTIVE organization for their session. It deliberately does NOT change
 * the home-tenant model: `users.tenant_id` is still authoritative for the
 * home tenant, and every existing row is backfilled here as the user's
 * `is_primary` membership so nothing regresses.
 *
 * SECURITY / ISOLATION:
 *   - This table is a CROSS-tenant mapping (user → tenants), so it is
 *     intentionally NOT registered in lib/tenant-tables.ts as tenant-owned.
 *     Every query is instead constrained by the authenticated `user_id`, and
 *     tenant switching is validated against it server-side (never trusting a
 *     client-supplied tenant id).
 *   - `isActiveMembership()` is the authorization primitive the organization
 *     switcher and session layer use: a user may only ever scope a session to
 *     a tenant they hold an ACTIVE membership in, whose tenant is also active.
 *
 * The schema self-heals at runtime (same pattern as tenant-service /
 * platform-roles) so existing installs converge without a manual migration.
 */
import { query } from "@/lib/db"
import { ensureTenantSchema, DEFAULT_TENANT_SLUG } from "@/lib/tenant-service"
import { type TenantRole, toTenantRole } from "@/lib/role-model"

export type MembershipStatus = "active" | "suspended"

export type TenantMembership = {
  id: number
  userId: number
  tenantId: number
  tenantRole: TenantRole
  isPrimary: boolean
  status: MembershipStatus
  createdAt: string
  updatedAt: string
}

/** A membership joined with its tenant, for the switcher UI / API. */
export type MembershipWithTenant = TenantMembership & {
  tenantName: string
  tenantSlug: string
  tenantStatus: string
}

// ---------------------------------------------------------------------------
// Self-healing schema (mirrors database/migrations/2026-12-31-user-tenant-memberships.sql)
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

async function foreignKeyExists(table: string, name: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema = DATABASE() AND table_name = ?
         AND constraint_name = ? AND constraint_type = 'FOREIGN KEY' LIMIT 1`,
    [table, name],
  )
  return rows.length > 0
}

async function runEnsure(): Promise<void> {
  await ensureTenantSchema() // guarantees tenants + users.tenant_id exist

  await query(`
    CREATE TABLE IF NOT EXISTS \`user_tenant_memberships\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`tenant_role\` ENUM('employee','module_admin','tenant_admin','tenant_owner') NOT NULL DEFAULT 'employee',
      \`is_primary\` TINYINT(1) NOT NULL DEFAULT 0,
      \`status\` ENUM('active','suspended') NOT NULL DEFAULT 'active',
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_membership_user_tenant\` (\`user_id\`, \`tenant_id\`),
      KEY \`idx_membership_user\` (\`user_id\`),
      KEY \`idx_membership_tenant\` (\`tenant_id\`),
      KEY \`idx_membership_user_status\` (\`user_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  if (!(await foreignKeyExists("user_tenant_memberships", "fk_membership_user"))) {
    await query(
      "ALTER TABLE `user_tenant_memberships` ADD CONSTRAINT `fk_membership_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE",
    ).catch(() => {})
  }
  if (!(await foreignKeyExists("user_tenant_memberships", "fk_membership_tenant"))) {
    await query(
      "ALTER TABLE `user_tenant_memberships` ADD CONSTRAINT `fk_membership_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE",
    ).catch(() => {})
  }

  // Backfill: every user's home tenant becomes their primary membership, with
  // the tenant_role carried over from the user row. Idempotent on the unique
  // (user_id, tenant_id) key, so re-running never duplicates or downgrades.
  await query(
    `INSERT INTO \`user_tenant_memberships\` (\`user_id\`, \`tenant_id\`, \`tenant_role\`, \`is_primary\`, \`status\`)
       SELECT u.id,
              COALESCE(u.tenant_id, (SELECT id FROM \`tenants\` WHERE slug = ? LIMIT 1)),
              COALESCE(NULLIF(u.tenant_role, ''), IF(u.role = 'admin', 'tenant_admin', 'employee')),
              1,
              'active'
         FROM \`users\` u
        WHERE COALESCE(u.tenant_id, (SELECT id FROM \`tenants\` WHERE slug = ? LIMIT 1)) IS NOT NULL
     ON DUPLICATE KEY UPDATE \`is_primary\` = \`user_tenant_memberships\`.\`is_primary\``,
    [DEFAULT_TENANT_SLUG, DEFAULT_TENANT_SLUG],
  ).catch((err) => {
    // A pre-role-axis install may not yet have users.tenant_role; retry without it.
    if ((err as { code?: string })?.code === "ER_BAD_FIELD_ERROR") {
      return query(
        `INSERT INTO \`user_tenant_memberships\` (\`user_id\`, \`tenant_id\`, \`tenant_role\`, \`is_primary\`, \`status\`)
           SELECT u.id,
                  COALESCE(u.tenant_id, (SELECT id FROM \`tenants\` WHERE slug = ? LIMIT 1)),
                  IF(u.role = 'admin', 'tenant_admin', 'employee'),
                  1,
                  'active'
             FROM \`users\` u
            WHERE COALESCE(u.tenant_id, (SELECT id FROM \`tenants\` WHERE slug = ? LIMIT 1)) IS NOT NULL
         ON DUPLICATE KEY UPDATE \`is_primary\` = \`user_tenant_memberships\`.\`is_primary\``,
        [DEFAULT_TENANT_SLUG, DEFAULT_TENANT_SLUG],
      )
    }
    throw err
  })
}

/** Ensure the membership table exists + is backfilled. Cached per process. */
export async function ensureMembershipSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type Row = {
  id: number
  user_id: number
  tenant_id: number
  tenant_role: string
  is_primary: number
  status: MembershipStatus
  created_at: string
  updated_at: string
}

function mapRow(row: Row): TenantMembership {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    tenantId: Number(row.tenant_id),
    tenantRole: toTenantRole(row.tenant_role),
    isPrimary: Boolean(row.is_primary),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Every organization a user can act in, joined with the tenant record. Only
 * ACTIVE memberships whose tenant is ACTIVE are returned — a suspended
 * membership or a suspended/inactive tenant is not a valid switch target.
 */
export async function listMembershipsForUser(userId: number): Promise<MembershipWithTenant[]> {
  await ensureMembershipSchema()
  const rows = await query<any[]>(
    `SELECT m.*, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
       FROM \`user_tenant_memberships\` m
       JOIN \`tenants\` t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND m.status = 'active' AND t.status = 'active'
      ORDER BY m.is_primary DESC, t.name ASC`,
    [userId],
  )
  return rows.map((r) => ({
    ...mapRow(r),
    tenantName: r.tenant_name ?? "",
    tenantSlug: r.tenant_slug ?? "",
    tenantStatus: r.tenant_status ?? "active",
  }))
}

/** All memberships for a user regardless of status (admin/management views). */
export async function listAllMembershipsForUser(userId: number): Promise<MembershipWithTenant[]> {
  await ensureMembershipSchema()
  const rows = await query<any[]>(
    `SELECT m.*, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
       FROM \`user_tenant_memberships\` m
       JOIN \`tenants\` t ON t.id = m.tenant_id
      WHERE m.user_id = ?
      ORDER BY m.is_primary DESC, t.name ASC`,
    [userId],
  )
  return rows.map((r) => ({
    ...mapRow(r),
    tenantName: r.tenant_name ?? "",
    tenantSlug: r.tenant_slug ?? "",
    tenantStatus: r.tenant_status ?? "active",
  }))
}

/**
 * THE authorization primitive for tenant switching. True only when the user
 * holds an ACTIVE membership in the tenant AND that tenant is itself ACTIVE.
 * Everything that scopes a session to a non-home tenant MUST gate on this.
 */
export async function isActiveMembership(userId: number, tenantId: number): Promise<boolean> {
  await ensureMembershipSchema()
  const rows = await query<any[]>(
    `SELECT 1
       FROM \`user_tenant_memberships\` m
       JOIN \`tenants\` t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active' AND t.status = 'active'
      LIMIT 1`,
    [userId, tenantId],
  )
  return rows.length > 0
}

/** The user's tenant_role within a specific tenant, or null if not a member. */
export async function getMembershipRole(userId: number, tenantId: number): Promise<TenantRole | null> {
  await ensureMembershipSchema()
  const rows = await query<{ tenant_role: string }[]>(
    `SELECT \`tenant_role\` FROM \`user_tenant_memberships\`
      WHERE \`user_id\` = ? AND \`tenant_id\` = ? AND \`status\` = 'active' LIMIT 1`,
    [userId, tenantId],
  )
  return rows[0] ? toTenantRole(rows[0].tenant_role) : null
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export class MembershipError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "MembershipError"
    this.status = status
  }
}

export type AddMembershipInput = {
  userId: number
  tenantId: number
  tenantRole?: TenantRole
  isPrimary?: boolean
  createdBy?: number | null
}

/**
 * Grant a user membership in a tenant (idempotent upsert on the unique key).
 * Validates that both the user and the tenant exist so a dangling membership
 * can never be created. Re-granting updates the role/status and re-activates a
 * previously suspended membership.
 */
export async function addMembership(input: AddMembershipInput): Promise<TenantMembership> {
  await ensureMembershipSchema()
  const userId = Number(input.userId)
  const tenantId = Number(input.tenantId)
  if (!Number.isInteger(userId) || userId <= 0) throw new MembershipError("A valid userId is required")
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new MembershipError("A valid tenantId is required")

  const [userExists, tenantExists] = await Promise.all([
    query<any[]>(`SELECT 1 FROM \`users\` WHERE id = ? LIMIT 1`, [userId]),
    query<any[]>(`SELECT 1 FROM \`tenants\` WHERE id = ? LIMIT 1`, [tenantId]),
  ])
  if (userExists.length === 0) throw new MembershipError("User not found", 404)
  if (tenantExists.length === 0) throw new MembershipError("Tenant not found", 404)

  const role = toTenantRole(input.tenantRole ?? "employee")
  const isPrimary = input.isPrimary ? 1 : 0

  if (isPrimary) {
    // A user has at most one primary organization — demote any existing primary.
    await query(`UPDATE \`user_tenant_memberships\` SET \`is_primary\` = 0 WHERE \`user_id\` = ?`, [userId])
  }

  await query(
    `INSERT INTO \`user_tenant_memberships\` (\`user_id\`, \`tenant_id\`, \`tenant_role\`, \`is_primary\`, \`status\`, \`created_by\`)
     VALUES (?, ?, ?, ?, 'active', ?)
     ON DUPLICATE KEY UPDATE
       \`tenant_role\` = VALUES(\`tenant_role\`),
       \`is_primary\` = VALUES(\`is_primary\`),
       \`status\` = 'active'`,
    [userId, tenantId, role, isPrimary, input.createdBy ?? null],
  )

  const rows = await query<Row[]>(
    `SELECT * FROM \`user_tenant_memberships\` WHERE \`user_id\` = ? AND \`tenant_id\` = ? LIMIT 1`,
    [userId, tenantId],
  )
  return mapRow(rows[0])
}

/**
 * Remove (or suspend) a user's membership in a tenant. The user's HOME/primary
 * membership can never be removed here — that would strip a user of their base
 * organization; change the home tenant through the user-management path instead.
 */
export async function removeMembership(userId: number, tenantId: number): Promise<void> {
  await ensureMembershipSchema()
  const rows = await query<Row[]>(
    `SELECT * FROM \`user_tenant_memberships\` WHERE \`user_id\` = ? AND \`tenant_id\` = ? LIMIT 1`,
    [userId, tenantId],
  )
  const existing = rows[0]
  if (!existing) throw new MembershipError("Membership not found", 404)
  if (existing.is_primary) {
    throw new MembershipError("Cannot remove a user's primary organization membership", 409)
  }
  await query(`DELETE FROM \`user_tenant_memberships\` WHERE \`user_id\` = ? AND \`tenant_id\` = ?`, [
    userId,
    tenantId,
  ])
}
