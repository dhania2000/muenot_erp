import "server-only"
import { query, withTransaction } from "@/lib/db"
import { ensureShopkeeperSchema } from "@/lib/shopkeeper"
import { assertSafeHostingModeCreate, assertSafeHostingModeUpdate } from "@/lib/tenant-db/activation"

/**
 * Tenant service — the single source of truth for tenant records and secure
 * tenant resolution. See database/migrations/2026-11-06-add-multi-tenant-foundation.sql
 * for the canonical schema; the ensure helpers below make existing databases
 * self-heal at runtime (matching the project's other lib/*-ensure helpers), so
 * no manual migration step is required to bring an install onto the tenant model.
 *
 * SECURITY: tenants are resolved from the authenticated user (users.tenant_id),
 * never from client-supplied values. `getTenantBySlug` exists for pre-auth
 * subdomain hints only and must never be used to grant access on its own.
 */

export const DEFAULT_TENANT_SLUG = "muenot"

export type DeploymentModel = "shared_database" | "separate_schema" | "dedicated_database"
export type TenantStatus = "active" | "suspended" | "inactive"
export const TENANT_TYPES = ["ENTERPRISE", "SME", "SHOPKEEPER"] as const
export type TenantType = (typeof TENANT_TYPES)[number]

export type Tenant = {
  id: number
  name: string
  slug: string
  status: TenantStatus
  tenant_type: TenantType
  deployment_model: DeploymentModel
  plan: string
  db_schema: string | null
  db_connection_ref: string | null
  settings: Record<string, unknown> | null
  is_platform_owner: boolean
  created_at: string
  updated_at: string
}

type TenantRow = Omit<Tenant, "is_platform_owner" | "settings"> & {
  is_platform_owner: number
  settings: string | Record<string, unknown> | null
}

function mapTenant(row: TenantRow): Tenant {
  let settings: Record<string, unknown> | null = null
  if (row.settings) {
    settings =
      typeof row.settings === "string"
        ? (() => {
            try {
              return JSON.parse(row.settings as string)
            } catch {
              return null
            }
          })()
        : (row.settings as Record<string, unknown>)
  }
  return {
    ...row,
    is_platform_owner: Boolean(row.is_platform_owner),
    settings,
  }
}

// ---------------------------------------------------------------------------
// Self-healing schema (runs once per process)
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )
  return rows.length > 0
}

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
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenants\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(150) NOT NULL,
      \`slug\` VARCHAR(100) NOT NULL,
      \`status\` ENUM('active','suspended','inactive') NOT NULL DEFAULT 'active',
      \`deployment_model\` ENUM('shared_database','separate_schema','dedicated_database')
          NOT NULL DEFAULT 'shared_database',
      \`plan\` VARCHAR(50) NOT NULL DEFAULT 'internal',
      \`db_schema\` VARCHAR(190) DEFAULT NULL,
      \`db_connection_ref\` VARCHAR(190) DEFAULT NULL,
      \`settings\` JSON DEFAULT NULL,
      \`is_platform_owner\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tenants_slug\` (\`slug\`),
      KEY \`idx_tenants_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Kept as a VARCHAR rather than altering the existing status enum. Existing
  // tenants deliberately default to ENTERPRISE, so this is additive.
  if (!(await columnExists("tenants", "tenant_type"))) {
    await query("ALTER TABLE `tenants` ADD COLUMN `tenant_type` VARCHAR(20) NOT NULL DEFAULT 'ENTERPRISE' AFTER `status`")
  }

  // Seed the default platform-owner tenant (Muenot). Idempotent on slug.
  await query(
    `INSERT INTO \`tenants\` (\`name\`, \`slug\`, \`status\`, \`deployment_model\`, \`plan\`, \`is_platform_owner\`)
     VALUES ('Muenot', ?, 'active', 'shared_database', 'internal', 1)
     ON DUPLICATE KEY UPDATE \`name\` = \`name\``,
    [DEFAULT_TENANT_SLUG],
  )

  // Attach users to a tenant (nullable during backfill).
  if (!(await columnExists("users", "tenant_id"))) {
    await query("ALTER TABLE `users` ADD COLUMN `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`")
  }

  // Backfill any unattached users onto the default tenant.
  await query(
    `UPDATE \`users\`
        SET \`tenant_id\` = (SELECT \`id\` FROM \`tenants\` WHERE \`slug\` = ? LIMIT 1)
      WHERE \`tenant_id\` IS NULL`,
    [DEFAULT_TENANT_SLUG],
  )

  if (!(await indexExists("users", "idx_users_tenant"))) {
    await query("ALTER TABLE `users` ADD KEY `idx_users_tenant` (`tenant_id`)")
  }
  if (!(await foreignKeyExists("users", "fk_users_tenant"))) {
    await query(
      "ALTER TABLE `users` ADD CONSTRAINT `fk_users_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE",
    )
  }
}

/** Ensure the tenant schema exists. Cached per process; safe to call often. */
export async function ensureTenantSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      // Reset so a later call can retry after a transient failure.
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function getTenantById(id: number): Promise<Tenant | null> {
  await ensureTenantSchema()
  const rows = await query<TenantRow[]>("SELECT * FROM `tenants` WHERE `id` = ? LIMIT 1", [id])
  return rows[0] ? mapTenant(rows[0]) : null
}

/**
 * Look up a tenant by slug/subdomain. Pre-authentication hint ONLY — never use
 * the result to authorize a request; the session tenant is authoritative.
 */
export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  await ensureTenantSchema()
  const rows = await query<TenantRow[]>("SELECT * FROM `tenants` WHERE `slug` = ? LIMIT 1", [
    slug.toLowerCase().trim(),
  ])
  return rows[0] ? mapTenant(rows[0]) : null
}

export async function getDefaultTenant(): Promise<Tenant | null> {
  return getTenantBySlug(DEFAULT_TENANT_SLUG)
}

export async function listTenants(): Promise<Tenant[]> {
  await ensureTenantSchema()
  const rows = await query<TenantRow[]>("SELECT * FROM `tenants` ORDER BY `is_platform_owner` DESC, `name` ASC")
  return rows.map(mapTenant)
}

/**
 * Resolve the tenant a user belongs to, straight from the source of truth
 * (users.tenant_id). Falls back to the default tenant for legacy rows that
 * predate the backfill.
 */
export async function resolveTenantIdForUser(userId: number): Promise<number | null> {
  await ensureTenantSchema()
  const rows = await query<{ tenant_id: number | null }[]>(
    "SELECT `tenant_id` FROM `users` WHERE `id` = ? LIMIT 1",
    [userId],
  )
  if (rows.length === 0) return null
  if (rows[0].tenant_id != null) return Number(rows[0].tenant_id)
  const fallback = await getDefaultTenant()
  return fallback?.id ?? null
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type CreateTenantInput = {
  name: string
  slug: string
  plan?: string
  deployment_model?: DeploymentModel
  db_schema?: string | null
  db_connection_ref?: string | null
  settings?: Record<string, unknown> | null
  tenant_type?: TenantType
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/

export async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  assertSafeHostingModeCreate(input.deployment_model ?? "shared_database")
  await ensureTenantSchema()
  const name = input.name?.trim()
  const slug = input.slug?.toLowerCase().trim()
  if (!name) throw new Error("Tenant name is required")
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error("Tenant slug must be 2-100 chars, lowercase letters, digits or hyphens")
  }
  const tenantType = input.tenant_type ?? "ENTERPRISE"
  if (!TENANT_TYPES.includes(tenantType)) throw new Error("Invalid tenant type")

  const existing = await getTenantBySlug(slug)
  if (existing) throw new Error(`A tenant with slug "${slug}" already exists`)

  const result = await query<{ insertId: number }>(
    `INSERT INTO \`tenants\`
       (\`name\`, \`slug\`, \`status\`, \`tenant_type\`, \`deployment_model\`, \`plan\`, \`db_schema\`, \`db_connection_ref\`, \`settings\`)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [
      name,
      slug,
      tenantType,
      input.deployment_model ?? "shared_database",
      input.plan ?? "standard",
      input.db_schema ?? null,
      input.db_connection_ref ?? null,
      input.settings ? JSON.stringify(input.settings) : null,
    ],
  )
  const created = await getTenantById(result.insertId)
  if (!created) throw new Error("Failed to load the tenant that was just created")
  // A Shopkeeper tenant gets its own profile row immediately; this is not a
  // second tenant model and it keeps the future mobile onboarding resumable.
  if (created.tenant_type === "SHOPKEEPER") {
    await ensureShopkeeperSchema()
    await query("INSERT INTO shopkeeper_profiles (tenant_id,shop_name) VALUES (?,?) ON DUPLICATE KEY UPDATE shop_name=shop_name", [created.id, created.name])
  }
  return created
}

const TENANT_STATUSES: TenantStatus[] = ["active", "suspended", "inactive"]

/**
 * Change a tenant's lifecycle status (suspend / reactivate / deactivate). The
 * platform-owner tenant (Muenot itself) can never be taken out of `active` —
 * suspending the platform's own tenant would lock every operator out. Returns
 * the updated tenant.
 */
export async function setTenantStatus(id: number, status: TenantStatus): Promise<Tenant> {
  await ensureTenantSchema()
  if (!TENANT_STATUSES.includes(status)) throw new Error(`Invalid tenant status "${status}"`)
  const tenant = await getTenantById(id)
  if (!tenant) throw new Error("Tenant not found")
  if (tenant.is_platform_owner && status !== "active") {
    throw new Error("The platform-owner tenant must remain active")
  }
  await query("UPDATE `tenants` SET `status` = ? WHERE `id` = ?", [status, id])
  const updated = await getTenantById(id)
  if (!updated) throw new Error("Failed to load the updated tenant")
  return updated
}

export type UpdateTenantInput = {
  name?: string
  plan?: string
  deployment_model?: DeploymentModel
}

const DEPLOYMENT_MODELS: DeploymentModel[] = ["shared_database", "separate_schema", "dedicated_database"]

/**
 * Update a tenant's editable business fields (display name, plan and
 * deployment model). Lifecycle status is intentionally handled separately by
 * `setTenantStatus`. Slug is immutable because it is used as a routing hint.
 */
export async function updateTenant(id: number, input: UpdateTenantInput): Promise<Tenant> {
  await ensureTenantSchema()
  const tenant = await getTenantById(id)
  if (!tenant) throw new Error("Tenant not found")

  const sets: string[] = []
  const values: any[] = []

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error("Tenant name is required")
    sets.push("`name` = ?")
    values.push(name)
  }
  if (input.plan !== undefined) {
    const plan = input.plan.trim()
    if (!plan) throw new Error("Plan is required")
    sets.push("`plan` = ?")
    values.push(plan)
  }
  if (input.deployment_model !== undefined) {
    if (!DEPLOYMENT_MODELS.includes(input.deployment_model)) throw new Error("Invalid deployment model")
    assertSafeHostingModeUpdate(tenant.deployment_model, input.deployment_model)
    sets.push("`deployment_model` = ?")
    values.push(input.deployment_model)
  }

  if (sets.length === 0) return tenant

  values.push(id)
  await query(`UPDATE \`tenants\` SET ${sets.join(", ")} WHERE \`id\` = ?`, values)
  const updated = await getTenantById(id)
  if (!updated) throw new Error("Failed to load the updated tenant")
  return updated
}

/**
 * Permanently delete a tenant and the rows that are not guaranteed to cascade.
 * The platform-owner tenant can never be deleted. Much of the ERP is declared
 * ON DELETE RESTRICT, so a tenant that already owns business data cannot be
 * torn apart — MySQL blocks the delete and we surface a clear 409 telling the
 * operator to deactivate the tenant instead.
 */
export async function deleteTenant(id: number): Promise<Tenant> {
  await ensureTenantSchema()
  const tenant = await getTenantById(id)
  if (!tenant) throw new Error("Tenant not found")
  if (tenant.is_platform_owner) throw new Error("The platform-owner tenant cannot be deleted")

  try {
    await withTransaction(async (conn) => {
      // Rows that are not guaranteed to cascade — remove them explicitly and in
      // dependency order before the tenant itself.
      await conn.query("DELETE FROM `tenant_subscriptions` WHERE `tenant_id` = ?", [id])
      await conn.query("DELETE FROM `shopkeeper_profiles` WHERE `tenant_id` = ?", [id])
      await conn.query("DELETE FROM `users` WHERE `tenant_id` = ?", [id])
      await conn.query("DELETE FROM `tenants` WHERE `id` = ?", [id])
    })
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === "ER_ROW_IS_REFERENCED_2" || code === "ER_ROW_IS_REFERENCED") {
      const e = new Error(
        "This tenant has associated business data and cannot be deleted. Deactivate the tenant instead.",
      ) as Error & { status?: number }
      e.status = 409
      throw e
    }
    throw err
  }

  return tenant
}
