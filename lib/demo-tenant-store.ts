import "server-only"
/**
 * Spec26 — Demo tenant & cloning (#121-122): the durable store.
 * ---------------------------------------------------------------------------
 * A demo tenant is a clearly-marked, throwaway copy of a canonical demo
 * TEMPLATE tenant that holds realistic-but-synthetic data. This module owns:
 *
 *   - the `demo_tenants` registry (one row per template/clone) + self-heal,
 *   - ensureDemoTemplate(): create/seed the single template idempotently,
 *   - cloneDemoTenant(): provision an ISOLATED tenant with FRESH ids and FRESH
 *     admin credentials, copy only the curated demo-safe tables (never secrets,
 *     integrations, billing or sessions — see lib/demo-tenant-model.ts),
 *   - resetDemoTenant(): re-materialize a clone from the template,
 *   - expiry + cleanup controls (TTL, expire overdue, purge).
 *
 * Everything is platform-axis (operator-only; enforced in the routes), every
 * mutation is written to the platform audit log, clone is idempotent on an
 * idempotency key, and the copy engine remaps tenant_id and regenerates
 * globally-unique columns so a clone can never collide with or read another
 * tenant. The schema self-heals at runtime (matching the rest of the codebase)
 * and the migration is the durable record.
 */
import { query } from "@/lib/db"
import { createTenant, getTenantBySlug } from "@/lib/tenant-service"
import { hashPassword, generateTempPassword } from "@/lib/password"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { ensureClientTables } from "@/lib/clients-db"
import {
  DEMO_CLIENT_SEED,
  DEMO_CLONE_SLUG_PREFIX,
  DEMO_CLONE_TABLES,
  DEMO_SETTINGS_KEY,
  DEMO_TEMPLATE_NAME,
  DEMO_TEMPLATE_SLUG,
  type DemoTenantKind,
  type DemoTenantStatus,
  assertDemoTablesSafe,
  computeExpiresAt,
  demoDaysRemaining,
  isDemoExpired,
  normalizeCloneInput,
  regenerateUniqueValue,
} from "@/lib/demo-tenant-model"

export type Actor = { userId: number; email?: string | null; name?: string | null }

export type DemoTenant = {
  id: number
  tenantId: number
  kind: DemoTenantKind
  sourceTemplateTenantId: number | null
  status: DemoTenantStatus
  label: string | null
  adminUserId: number | null
  adminEmail: string | null
  expiresAt: string | null
  expired: boolean
  daysRemaining: number | null
  createdBy: number | null
  seededAt: string | null
  lastResetAt: string | null
  cleanedAt: string | null
  createdAt: string
  updatedAt: string
}

function mapRow(r: any, now: Date = new Date()): DemoTenant {
  const expiresAt: string | null = r.expires_at ?? null
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    kind: r.kind,
    sourceTemplateTenantId: r.source_template_tenant_id == null ? null : Number(r.source_template_tenant_id),
    status: r.status,
    label: r.label ?? null,
    adminUserId: r.admin_user_id == null ? null : Number(r.admin_user_id),
    adminEmail: r.admin_email ?? null,
    expiresAt,
    expired: r.kind === "clone" && r.status !== "cleaned" && isDemoExpired(expiresAt, now),
    daysRemaining: r.kind === "clone" && expiresAt ? demoDaysRemaining(expiresAt, now) : null,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    seededAt: r.seeded_at ?? null,
    lastResetAt: r.last_reset_at ?? null,
    cleanedAt: r.cleaned_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------
let schemaReady: Promise<void> | null = null

export function ensureDemoTenantSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS \`demo_tenants\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT UNSIGNED NOT NULL,
          \`kind\` ENUM('template','clone') NOT NULL,
          \`source_template_tenant_id\` INT UNSIGNED NULL,
          \`status\` ENUM('active','expired','cleaned') NOT NULL DEFAULT 'active',
          \`label\` VARCHAR(190) NULL,
          \`admin_user_id\` INT UNSIGNED NULL,
          \`admin_email\` VARCHAR(190) NULL,
          \`expires_at\` DATETIME NULL,
          \`created_by\` INT UNSIGNED NULL,
          \`idempotency_key\` VARCHAR(100) NULL,
          \`seeded_at\` DATETIME NULL,
          \`last_reset_at\` DATETIME NULL,
          \`cleaned_at\` DATETIME NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uq_demo_tenant\` (\`tenant_id\`),
          UNIQUE KEY \`uq_demo_idem\` (\`idempotency_key\`),
          KEY \`idx_demo_kind_status\` (\`kind\`, \`status\`),
          KEY \`idx_demo_expires\` (\`expires_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      )
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listDemoTenants(): Promise<DemoTenant[]> {
  await ensureDemoTenantSchema()
  const rows = (await query(`SELECT * FROM \`demo_tenants\` ORDER BY \`id\` DESC`)) as any[]
  const now = new Date()
  return rows.map((r) => mapRow(r, now))
}

export async function getDemoTenant(id: number): Promise<DemoTenant | null> {
  await ensureDemoTenantSchema()
  const rows = (await query(`SELECT * FROM \`demo_tenants\` WHERE \`id\` = ? LIMIT 1`, [id])) as any[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getDemoTenantByTenantId(tenantId: number): Promise<DemoTenant | null> {
  await ensureDemoTenantSchema()
  const rows = (await query(`SELECT * FROM \`demo_tenants\` WHERE \`tenant_id\` = ? LIMIT 1`, [tenantId])) as any[]
  return rows[0] ? mapRow(rows[0]) : null
}

async function getTemplateRow(): Promise<DemoTenant | null> {
  await ensureDemoTenantSchema()
  const rows = (await query(
    `SELECT * FROM \`demo_tenants\` WHERE \`kind\` = 'template' AND \`status\` = 'active' LIMIT 1`,
  )) as any[]
  return rows[0] ? mapRow(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * Ensure the single canonical demo template exists and is seeded with synthetic
 * data. Idempotent: a second call returns the existing template untouched.
 */
export async function ensureDemoTemplate(actor: Actor): Promise<DemoTenant> {
  await ensureDemoTenantSchema()
  assertDemoTablesSafe()

  const existing = await getTemplateRow()
  if (existing) return existing

  // A template may already exist as a tenant (re-run after a partial failure).
  const existingTenant = await getTenantBySlug(DEMO_TEMPLATE_SLUG)
  const tenant =
    existingTenant ??
    (await createTenant({
      name: DEMO_TEMPLATE_NAME,
      slug: DEMO_TEMPLATE_SLUG,
      plan: "demo",
      tenant_type: "SME",
      settings: { [DEMO_SETTINGS_KEY]: { role: "template", synthetic: true } },
    }))

  await seedSyntheticData(tenant.id)

  const result = (await query(
    `INSERT INTO \`demo_tenants\`
       (\`tenant_id\`, \`kind\`, \`status\`, \`label\`, \`created_by\`, \`seeded_at\`)
     VALUES (?, 'template', 'active', ?, ?, NOW())`,
    [tenant.id, DEMO_TEMPLATE_NAME, actor.userId],
  )) as any
  const id = Number(result.insertId)

  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
    action: "demo_template_created",
    targetTenantId: tenant.id,
    detail: { slug: DEMO_TEMPLATE_SLUG, seededClients: DEMO_CLIENT_SEED.length },
  })

  return (await getDemoTenant(id))!
}

/** Insert the synthetic seed rows into a tenant's demo-safe tables. */
async function seedSyntheticData(tenantId: number): Promise<void> {
  await ensureClientTables().catch(() => {})
  for (const c of DEMO_CLIENT_SEED) {
    const row: Record<string, unknown> = {
      tenant_id: tenantId,
      client_code: c.client_code,
      client_name: c.client_name,
      email: c.email,
      company_name: c.company_name,
      mobile: c.mobile,
      city: c.city,
      state: c.state,
      country: c.country,
      currency: c.currency,
      category: c.category,
      status: c.status,
    }
    await insertRow("clients", row).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export type CloneResult = {
  demo: DemoTenant
  tenantId: number
  adminEmail: string
  /** Returned only when a NEW clone was provisioned (never on an idempotent replay). */
  adminTempPassword: string | null
}

/**
 * Provision an isolated demo tenant cloned from the template. Idempotent on
 * `idempotencyKey`: a replay returns the already-created clone (without a new
 * password) instead of creating a second tenant.
 */
export async function cloneDemoTenant(
  actor: Actor,
  input: unknown,
  idempotencyKey?: string | null,
): Promise<CloneResult> {
  await ensureDemoTenantSchema()
  assertDemoTablesSafe()

  const key = normalizeIdempotencyKey(idempotencyKey)
  if (key) {
    const rows = (await query(`SELECT * FROM \`demo_tenants\` WHERE \`idempotency_key\` = ? LIMIT 1`, [key])) as any[]
    if (rows[0]) {
      const demo = mapRow(rows[0])
      return { demo, tenantId: demo.tenantId, adminEmail: demo.adminEmail ?? "", adminTempPassword: null }
    }
  }

  const { label, ttlDays } = normalizeCloneInput(input)
  const template = await ensureDemoTemplate(actor)

  const token = randomToken()
  const now = new Date()
  const expiresAt = computeExpiresAt(now, ttlDays)

  // 1) Fresh, isolated tenant.
  const tenant = await createTenant({
    name: `${label} (Demo)`.slice(0, 150),
    slug: `${DEMO_CLONE_SLUG_PREFIX}-${token}`,
    plan: "demo",
    tenant_type: "SME",
    settings: {
      [DEMO_SETTINGS_KEY]: {
        role: "clone",
        synthetic: true,
        sourceTemplateTenantId: template.tenantId,
        expiresAt: expiresAt.toISOString(),
      },
    },
  })

  // 2) Fresh admin credentials — never copied from any real user.
  const adminEmail = `demo-admin+${token}@demo.muenot.test`
  const adminTempPassword = generateTempPassword(14)
  const passwordHash = await hashPassword(adminTempPassword)
  const adminRes = (await query(
    `INSERT INTO \`users\`
       (\`tenant_id\`, \`name\`, \`email\`, \`password_hash\`, \`role\`, \`platform_role\`, \`tenant_role\`, \`designation\`, \`status\`, \`must_change_password\`)
     VALUES (?, ?, ?, ?, 'admin', 'none', 'tenant_owner', 'Demo Admin', 'active', 1)`,
    [tenant.id, `${label} Admin`.slice(0, 150), adminEmail, passwordHash],
  )) as any
  const adminUserId = Number(adminRes.insertId)

  // 3) Copy only the curated demo-safe tables, remapping tenant + unique keys.
  await copyDemoData(template.tenantId, tenant.id)

  // 4) Register the clone with its TTL.
  const result = (await query(
    `INSERT INTO \`demo_tenants\`
       (\`tenant_id\`, \`kind\`, \`source_template_tenant_id\`, \`status\`, \`label\`, \`admin_user_id\`, \`admin_email\`, \`expires_at\`, \`created_by\`, \`idempotency_key\`, \`seeded_at\`)
     VALUES (?, 'clone', ?, 'active', ?, ?, ?, ?, ?, ?, NOW())`,
    [tenant.id, template.tenantId, label, adminUserId, adminEmail, toSqlDatetime(expiresAt), actor.userId, key],
  )) as any
  const id = Number(result.insertId)

  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
    action: "demo_tenant_cloned",
    targetTenantId: tenant.id,
    targetUserId: adminUserId,
    detail: { label, ttlDays, sourceTemplateTenantId: template.tenantId, slug: tenant.slug },
  })

  const demo = (await getDemoTenant(id))!
  return { demo, tenantId: tenant.id, adminEmail, adminTempPassword }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/** Wipe a clone's demo data and re-materialize it from the template. */
export async function resetDemoTenant(actor: Actor, id: number): Promise<DemoTenant> {
  await ensureDemoTenantSchema()
  const demo = await getDemoTenant(id)
  if (!demo) throw new DemoTenantError("Demo tenant not found", 404)
  if (demo.kind !== "clone") throw new DemoTenantError("Only cloned demo tenants can be reset", 400)
  if (demo.status === "cleaned") throw new DemoTenantError("This demo tenant has been cleaned up and cannot be reset", 409)

  const template = await getTemplateRow()
  if (!template) throw new DemoTenantError("No demo template exists to reset from", 409)

  await deleteDemoData(demo.tenantId)
  await copyDemoData(template.tenantId, demo.tenantId)

  await query(
    `UPDATE \`demo_tenants\` SET \`status\` = 'active', \`last_reset_at\` = NOW() WHERE \`id\` = ?`,
    [id],
  )
  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
    action: "demo_tenant_reset",
    targetTenantId: demo.tenantId,
    detail: { demoId: id },
  })
  return (await getDemoTenant(id))!
}

// ---------------------------------------------------------------------------
// Expiry + cleanup
// ---------------------------------------------------------------------------

/** Flip overdue active clones to `expired`. Safe to run repeatedly. */
export async function expireOverdueDemoTenants(now: Date = new Date()): Promise<number> {
  await ensureDemoTenantSchema()
  const rows = (await query(
    `SELECT * FROM \`demo_tenants\` WHERE \`kind\` = 'clone' AND \`status\` = 'active'`,
  )) as any[]
  let expired = 0
  for (const r of rows) {
    if (isDemoExpired(r.expires_at ?? null, now)) {
      await query(`UPDATE \`demo_tenants\` SET \`status\` = 'expired' WHERE \`id\` = ?`, [r.id])
      expired++
    }
  }
  return expired
}

export type CleanupSummary = { expired: number; purged: number; purgedTenantIds: number[] }

/**
 * Expire overdue clones then physically purge them: delete their synthetic
 * business rows, their users and the tenant record, and mark the demo row
 * `cleaned`. Templates are never purged. Idempotent.
 */
export async function cleanupExpiredDemoTenants(actor: Actor | null = null, now: Date = new Date()): Promise<CleanupSummary> {
  await ensureDemoTenantSchema()
  const expired = await expireOverdueDemoTenants(now)

  const rows = (await query(
    `SELECT * FROM \`demo_tenants\` WHERE \`kind\` = 'clone' AND \`status\` = 'expired'`,
  )) as any[]

  const purgedTenantIds: number[] = []
  for (const r of rows) {
    const tenantId = Number(r.tenant_id)
    await deleteDemoData(tenantId)
    await query(`DELETE FROM \`users\` WHERE \`tenant_id\` = ?`, [tenantId]).catch(() => {})
    await query(`DELETE FROM \`tenants\` WHERE \`id\` = ? AND \`is_platform_owner\` = 0`, [tenantId]).catch(() => {})
    await query(
      `UPDATE \`demo_tenants\` SET \`status\` = 'cleaned', \`cleaned_at\` = NOW() WHERE \`id\` = ?`,
      [r.id],
    )
    purgedTenantIds.push(tenantId)
    await recordPlatformAudit({
      actorUserId: actor?.userId ?? 0,
      actorEmail: actor?.email ?? null,
      action: "demo_tenant_cleaned",
      targetTenantId: tenantId,
      detail: { demoId: Number(r.id), label: r.label ?? null },
    }).catch(() => {})
  }

  return { expired, purged: purgedTenantIds.length, purgedTenantIds }
}

// ---------------------------------------------------------------------------
// Copy engine (curated, tenant-remapping, unique-key regenerating)
// ---------------------------------------------------------------------------

async function copyDemoData(fromTenantId: number, toTenantId: number): Promise<void> {
  for (const spec of DEMO_CLONE_TABLES) {
    let rows: any[]
    try {
      rows = (await query(`SELECT * FROM \`${spec.table}\` WHERE \`tenant_id\` = ?`, [fromTenantId])) as any[]
    } catch {
      // Table absent or missing tenant_id in this install — skip it safely.
      continue
    }
    if (!Array.isArray(rows)) continue
    const regen = new Set([...spec.uniqueColumns, ...spec.emailColumns])
    for (const src of rows) {
      const row: Record<string, unknown> = { ...src }
      delete row.id // let the target assign a FRESH primary key
      row.tenant_id = toTenantId
      for (const col of regen) {
        if (col in row && row[col] != null) row[col] = regenerateUniqueValue(row[col], toTenantId)
      }
      await insertRow(spec.table, row).catch(() => {})
    }
  }
}

async function deleteDemoData(tenantId: number): Promise<void> {
  for (const spec of DEMO_CLONE_TABLES) {
    await query(`DELETE FROM \`${spec.table}\` WHERE \`tenant_id\` = ?`, [tenantId]).catch(() => {})
  }
}

/** Insert a single row from a column→value map (single-tuple; parameterized). */
async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row)
  if (cols.length === 0) return
  const colSql = cols.map((c) => `\`${c}\``).join(", ")
  const placeholders = cols.map(() => "?").join(", ")
  await query(`INSERT INTO \`${table}\` (${colSql}) VALUES (${placeholders})`, cols.map((c) => row[c]))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class DemoTenantError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "DemoTenantError"
    this.status = status
  }
}

function normalizeIdempotencyKey(key?: string | null): string | null {
  if (!key) return null
  const trimmed = String(key).trim()
  if (!trimmed) return null
  return trimmed.slice(0, 100)
}

function randomToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function toSqlDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}
