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
 *     admin credentials, copying only curated demo-safe tables (never secrets,
 *     integrations, billing or sessions — see lib/demo-tenant-model.ts). A
 *     failure mid-clone compensates by discarding the partial tenant.
 *   - resetDemoTenant(): re-materialize a clone's seeded data from the template,
 *     optionally rotating the admin credentials,
 *   - extend / expire / cleanup controls. Expiry is enforced at sign-in via the
 *     existing users.access_expires_at gate + session revocation + tenant
 *     suspension; cleanup purges every tenant-owned row and reuses deleteTenant().
 *
 * Reuses tenant-service (create/status/delete), session-store (revocation),
 * user-lifecycle (access_expires_at column) and the platform audit log.
 * Operator-only authorization is enforced in the routes.
 */
import { query } from "@/lib/db"
import { createTenant, deleteTenant, getTenantById, getTenantBySlug, setTenantStatus } from "@/lib/tenant-service"
import { hashPassword, generateTempPassword } from "@/lib/password"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { ensureClientTables } from "@/lib/clients-db"
import { revokeAllSessionsForUser } from "@/lib/session-store"
import { ensureUserLifecycleSchema } from "@/lib/user-lifecycle"
import { TENANT_OWNED_TABLES } from "@/lib/tenant-tables"
import {
  DEMO_CLIENT_SEED,
  DEMO_CLONE_SLUG_PREFIX,
  DEMO_CLONE_TABLES,
  DEMO_SETTINGS_KEY,
  DEMO_TEMPLATE_NAME,
  DEMO_TEMPLATE_SLUG,
  MAX_ACTIVE_DEMO_CLONES,
  type DemoTenantKind,
  type DemoTenantStatus,
  assertDemoTablesSafe,
  buildClonedRow,
  computeExpiresAt,
  demoDaysRemaining,
  demoPurgeTables,
  extendExpiry,
  isDemoCloneTenantRecord,
  isDemoExpired,
  normalizeCloneInput,
  parseExtendDays,
  scopeIdempotencyKey,
  toSqlDatetime,
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

export class DemoTenantError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "DemoTenantError"
    this.status = status
  }
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
    expired: r.kind === "clone" && r.status !== "cleaned" && (r.status === "expired" || isDemoExpired(expiresAt, now)),
    daysRemaining: r.kind === "clone" && expiresAt && r.status === "active" ? demoDaysRemaining(expiresAt, now) : null,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    seededAt: r.seeded_at ?? null,
    lastResetAt: r.last_reset_at ?? null,
    cleanedAt: r.cleaned_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Self-healing schema (the migration is the durable record)
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

export async function getDemoTemplate(): Promise<DemoTenant | null> {
  return getTemplateRow()
}

async function requireClone(id: number): Promise<DemoTenant> {
  const demo = await getDemoTenant(id)
  if (!demo) throw new DemoTenantError("Demo tenant not found", 404)
  if (demo.kind !== "clone") throw new DemoTenantError("The demo template cannot be modified by this action", 400)
  if (demo.status === "cleaned") throw new DemoTenantError("This demo tenant has already been cleaned up", 409)
  return demo
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

function isTemplateTenantRecord(t: { plan?: string | null; settings?: any } | null): boolean {
  if (!t || t.plan !== "demo") return false
  const s = typeof t.settings === "string" ? safeJson(t.settings) : t.settings
  return s?.[DEMO_SETTINGS_KEY]?.role === "template"
}

/**
 * Ensure the single canonical demo template exists and is seeded with synthetic
 * data. Idempotent. Refuses to adopt a pre-existing `demo-template` slug that is
 * not itself marked as a demo template (never repurpose a real tenant).
 */
export async function ensureDemoTemplate(actor: Actor): Promise<DemoTenant> {
  await ensureDemoTenantSchema()
  assertDemoTablesSafe()

  const existing = await getTemplateRow()
  if (existing) return existing

  const existingTenant = await getTenantBySlug(DEMO_TEMPLATE_SLUG)
  if (existingTenant && !isTemplateTenantRecord(existingTenant)) {
    throw new DemoTenantError(
      `A tenant with slug "${DEMO_TEMPLATE_SLUG}" exists but is not a demo template; refusing to reuse it`,
      409,
    )
  }
  const tenant =
    existingTenant ??
    (await createTenant({
      name: DEMO_TEMPLATE_NAME,
      slug: DEMO_TEMPLATE_SLUG,
      plan: "demo",
      tenant_type: "SME",
      settings: { [DEMO_SETTINGS_KEY]: { role: "template", synthetic: true } },
    }))

  const seeded = await seedSyntheticData(tenant.id)

  let id: number
  try {
    const result = (await query(
      `INSERT INTO \`demo_tenants\`
         (\`tenant_id\`, \`kind\`, \`status\`, \`label\`, \`created_by\`, \`seeded_at\`)
       VALUES (?, 'template', 'active', ?, ?, ?)`,
      [tenant.id, DEMO_TEMPLATE_NAME, actor.userId, toSqlDatetime(new Date())],
    )) as any
    id = Number(result.insertId)
  } catch (err: any) {
    // Concurrent first-call race: the other request registered it.
    if (isDuplicateKey(err)) {
      const winner = await getTemplateRow()
      if (winner) return winner
    }
    throw err
  }

  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
    action: "demo_template_created",
    targetTenantId: tenant.id,
    detail: { slug: DEMO_TEMPLATE_SLUG, seededClients: seeded },
  })

  return (await getDemoTenant(id))!
}

/** Insert the synthetic seed rows that are not already present. Errors propagate. */
async function seedSyntheticData(tenantId: number): Promise<number> {
  await ensureClientTables()
  const existing = (await query(`SELECT \`client_code\` FROM \`clients\` WHERE \`tenant_id\` = ?`, [tenantId])) as any[]
  const have = new Set(existing.map((r) => String(r.client_code)))
  let inserted = 0
  for (const c of DEMO_CLIENT_SEED) {
    if (have.has(c.client_code)) continue
    await insertRow("clients", { tenant_id: tenantId, ...c })
    inserted++
  }
  return inserted
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
  replayed: boolean
}

async function findByIdempotencyKey(key: string): Promise<DemoTenant | null> {
  const rows = (await query(`SELECT * FROM \`demo_tenants\` WHERE \`idempotency_key\` = ? LIMIT 1`, [key])) as any[]
  return rows[0] ? mapRow(rows[0]) : null
}

function replay(demo: DemoTenant): CloneResult {
  return { demo, tenantId: demo.tenantId, adminEmail: demo.adminEmail ?? "", adminTempPassword: null, replayed: true }
}

/**
 * Provision an isolated demo tenant cloned from the template. Idempotent on an
 * operator-scoped key: a replay returns the existing clone WITHOUT re-issuing a
 * password. Any failure after the tenant is created discards the partial clone.
 */
export async function cloneDemoTenant(
  actor: Actor,
  input: unknown,
  idempotencyKey?: string | null,
): Promise<CloneResult> {
  await ensureDemoTenantSchema()
  assertDemoTablesSafe()

  let key: string | null
  try {
    key = scopeIdempotencyKey(actor.userId, idempotencyKey)
  } catch (err: any) {
    throw new DemoTenantError(err.message, 400)
  }
  if (key) {
    const hit = await findByIdempotencyKey(key)
    if (hit) return replay(hit)
  }

  const { label, ttlDays } = normalizeCloneInput(input)

  const countRows = (await query(
    `SELECT COUNT(*) AS n FROM \`demo_tenants\` WHERE \`kind\` = 'clone' AND \`status\` = 'active'`,
  )) as any[]
  if (Number(countRows[0]?.n ?? 0) >= MAX_ACTIVE_DEMO_CLONES) {
    throw new DemoTenantError(
      `At most ${MAX_ACTIVE_DEMO_CLONES} active demo tenants are allowed; clean up expired demos first`,
      429,
    )
  }

  const template = await ensureDemoTemplate(actor)
  await ensureUserLifecycleSchema()

  const token = randomToken()
  const now = new Date()
  const expiresAt = computeExpiresAt(now, ttlDays)
  let tenantId: number | null = null

  try {
    // 1) Fresh, isolated tenant, self-marked as a synthetic demo clone.
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
    tenantId = tenant.id

    // 2) Fresh admin credentials — never copied from any real user. Sign-in is
    //    blocked after expiry by the existing access_expires_at gate.
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
    await query(`UPDATE \`users\` SET \`access_expires_at\` = ? WHERE \`id\` = ? AND \`tenant_id\` = ?`, [
      toSqlDatetime(expiresAt),
      adminUserId,
      tenant.id,
    ])

    // 3) Copy only the curated demo-safe tables, remapping tenant + unique keys.
    const copied = await copyDemoData(template.tenantId, tenant.id)

    // 4) Register the clone. The unique idempotency key settles concurrent races.
    let id: number
    try {
      const result = (await query(
        `INSERT INTO \`demo_tenants\`
           (\`tenant_id\`, \`kind\`, \`source_template_tenant_id\`, \`status\`, \`label\`, \`admin_user_id\`, \`admin_email\`, \`expires_at\`, \`created_by\`, \`idempotency_key\`, \`seeded_at\`)
         VALUES (?, 'clone', ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenant.id,
          template.tenantId,
          label,
          adminUserId,
          adminEmail,
          toSqlDatetime(expiresAt),
          actor.userId,
          key,
          toSqlDatetime(now),
        ],
      )) as any
      id = Number(result.insertId)
    } catch (err: any) {
      if (key && isDuplicateKey(err)) {
        const winner = await findByIdempotencyKey(key)
        if (winner) {
          await discardPartialClone(tenant.id)
          tenantId = null
          return replay(winner)
        }
      }
      throw err
    }

    await recordPlatformAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
      action: "demo_tenant_cloned",
      targetTenantId: tenant.id,
      targetUserId: adminUserId,
      detail: { demoId: id, label, ttlDays, sourceTemplateTenantId: template.tenantId, slug: tenant.slug, copied },
    })

    const demo = (await getDemoTenant(id))!
    return { demo, tenantId: tenant.id, adminEmail, adminTempPassword, replayed: false }
  } catch (err: any) {
    if (tenantId != null) {
      await discardPartialClone(tenantId).catch((e) =>
        console.error("[demo-tenant] failed to discard partial clone", tenantId, e?.message),
      )
      await recordPlatformAudit({
        actorUserId: actor.userId,
        actorEmail: actor.email ?? null,
        action: "demo_tenant_clone_failed",
        targetTenantId: tenantId,
        detail: { error: String(err?.message ?? err).slice(0, 300) },
      }).catch(() => {})
    }
    if (err instanceof DemoTenantError) throw err
    throw new DemoTenantError(`Demo clone failed and was rolled back: ${err?.message ?? "unknown error"}`, 500)
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export type ResetResult = { demo: DemoTenant; adminTempPassword: string | null }

/**
 * Wipe a clone's seeded demo data and re-materialize it from the template.
 * Status and expiry are unchanged (reset never revives an expired demo — use
 * extend). With rotateCredentials, the admin gets a fresh temporary password
 * and every existing session of that admin is revoked.
 */
export async function resetDemoTenant(
  actor: Actor,
  id: number,
  opts: { rotateCredentials?: boolean } = {},
): Promise<ResetResult> {
  await ensureDemoTenantSchema()
  const demo = await requireClone(id)
  const template = await getTemplateRow()
  if (!template) throw new DemoTenantError("No demo template exists to reset from", 409)
  if (template.tenantId === demo.tenantId) throw new DemoTenantError("Refusing to reset the template onto itself", 400)

  await deleteDemoData(demo.tenantId)
  const copied = await copyDemoData(template.tenantId, demo.tenantId)

  let adminTempPassword: string | null = null
  if (opts.rotateCredentials && demo.adminUserId) {
    adminTempPassword = generateTempPassword(14)
    const hash = await hashPassword(adminTempPassword)
    await query(
      `UPDATE \`users\` SET \`password_hash\` = ?, \`must_change_password\` = 1 WHERE \`id\` = ? AND \`tenant_id\` = ?`,
      [hash, demo.adminUserId, demo.tenantId],
    )
    await revokeAllSessionsForUser(demo.adminUserId, { reason: "demo_credentials_rotated" })
  }

  await query(`UPDATE \`demo_tenants\` SET \`last_reset_at\` = ? WHERE \`id\` = ?`, [toSqlDatetime(new Date()), id])
  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
    action: "demo_tenant_reset",
    targetTenantId: demo.tenantId,
    detail: { demoId: id, copied, rotatedCredentials: !!adminTempPassword },
  })
  return { demo: (await getDemoTenant(id))!, adminTempPassword }
}

// ---------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------

/** Push a clone's expiry out (capped). Reactivates an expired-but-not-cleaned clone. */
export async function extendDemoTenant(actor: Actor, id: number, daysInput: unknown): Promise<DemoTenant> {
  await ensureDemoTenantSchema()
  const days = parseExtendDays(daysInput)
  if (days == null) throw new DemoTenantError("days must be a whole number between 1 and 90", 400)
  const demo = await requireClone(id)

  const next = extendExpiry(demo.expiresAt, new Date(), days)
  const nextSql = toSqlDatetime(next)
  await ensureUserLifecycleSchema()
  if (demo.status === "expired") await setTenantStatus(demo.tenantId, "active")
  await query(`UPDATE \`users\` SET \`access_expires_at\` = ? WHERE \`tenant_id\` = ?`, [nextSql, demo.tenantId])
  await query(`UPDATE \`demo_tenants\` SET \`expires_at\` = ?, \`status\` = 'active' WHERE \`id\` = ?`, [nextSql, id])

  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email ?? null,
    action: "demo_tenant_extended",
    targetTenantId: demo.tenantId,
    detail: { demoId: id, days, from: demo.expiresAt, to: nextSql, reactivated: demo.status === "expired" },
  })
  return (await getDemoTenant(id))!
}

// ---------------------------------------------------------------------------
// Expire
// ---------------------------------------------------------------------------

/**
 * Lock a clone out: suspend the tenant, set every user's access_expires_at to
 * now (blocks sign-in via the existing gate) and revoke live sessions, then
 * flip the registry row. Side effects run first and are idempotent, so a
 * failure is retried by the next sweep; the atomic status flip settles races.
 */
async function expireOne(row: { id: number; tenant_id: number; label?: string | null }, actor: Actor | null, reason: string) {
  const tenantId = Number(row.tenant_id)
  await ensureUserLifecycleSchema()
  const tenant = await getTenantById(tenantId)
  if (tenant && isDemoCloneTenantRecord(tenant)) {
    await setTenantStatus(tenantId, "suspended")
  }
  await query(`UPDATE \`users\` SET \`access_expires_at\` = ? WHERE \`tenant_id\` = ?`, [toSqlDatetime(new Date()), tenantId])
  const users = (await query(`SELECT \`id\` FROM \`users\` WHERE \`tenant_id\` = ?`, [tenantId])) as any[]
  for (const u of users) await revokeAllSessionsForUser(Number(u.id), { reason: "demo_expired" })

  const res = (await query(
    `UPDATE \`demo_tenants\` SET \`status\` = 'expired' WHERE \`id\` = ? AND \`status\` = 'active'`,
    [row.id],
  )) as any
  if (Number(res?.affectedRows ?? 0) > 0) {
    await recordPlatformAudit({
      actorUserId: actor?.userId ?? 0,
      actorEmail: actor?.email ?? null,
      action: "demo_tenant_expired",
      targetTenantId: tenantId,
      detail: { demoId: Number(row.id), reason },
    }).catch(() => {})
    return true
  }
  return false
}

/** Operator control: expire a single clone immediately. */
export async function forceExpireDemoTenant(actor: Actor, id: number): Promise<DemoTenant> {
  await ensureDemoTenantSchema()
  const demo = await requireClone(id)
  if (demo.status === "active") {
    await expireOne({ id: demo.id, tenant_id: demo.tenantId, label: demo.label }, actor, "manual")
  }
  return (await getDemoTenant(id))!
}

/** Flip overdue active clones to `expired`. Safe to run repeatedly. */
export async function expireOverdueDemoTenants(now: Date = new Date(), actor: Actor | null = null): Promise<number> {
  await ensureDemoTenantSchema()
  const rows = (await query(
    `SELECT * FROM \`demo_tenants\` WHERE \`kind\` = 'clone' AND \`status\` = 'active'`,
  )) as any[]
  let expired = 0
  for (const r of rows) {
    if (isDemoExpired(r.expires_at ?? null, now) && (await expireOne(r, actor, "ttl"))) expired++
  }
  return expired
}

// ---------------------------------------------------------------------------
// Cleanup (purge)
// ---------------------------------------------------------------------------

export type CleanupFailure = { demoId: number; tenantId: number; error: string }
export type CleanupSummary = { expired: number; purged: number; purgedTenantIds: number[]; failed: CleanupFailure[] }

/**
 * Physically purge one EXPIRED clone. Refuses unless the tenant record itself
 * carries every demo-clone marker, so a corrupted registry row can never delete
 * a real tenant. A missing tenant is treated as already purged.
 */
async function purgeOne(row: any, actor: Actor | null): Promise<void> {
  const tenantId = Number(row.tenant_id)
  const tenant = await getTenantById(tenantId)
  if (tenant) {
    if (!isDemoCloneTenantRecord(tenant)) {
      throw new Error("tenant is not marked as a synthetic demo clone; refusing to purge")
    }
    await purgeTenantData(tenantId)
    await deleteTenant(tenantId)
  }
  await query(
    `UPDATE \`demo_tenants\` SET \`status\` = 'cleaned', \`cleaned_at\` = ? WHERE \`id\` = ? AND \`status\` = 'expired'`,
    [toSqlDatetime(new Date()), row.id],
  )
  await recordPlatformAudit({
    actorUserId: actor?.userId ?? 0,
    actorEmail: actor?.email ?? null,
    action: "demo_tenant_cleaned",
    targetTenantId: tenantId,
    detail: { demoId: Number(row.id), label: row.label ?? null, tenantAlreadyGone: !tenant },
  }).catch(() => {})
}

/**
 * Expire overdue clones then purge every expired clone. Templates are never
 * selected. Per-clone failures are collected (the row stays `expired` so the
 * next sweep retries) instead of aborting the whole sweep. Idempotent.
 */
export async function cleanupExpiredDemoTenants(actor: Actor | null = null, now: Date = new Date()): Promise<CleanupSummary> {
  await ensureDemoTenantSchema()
  const expired = await expireOverdueDemoTenants(now, actor)
  const rows = (await query(
    `SELECT * FROM \`demo_tenants\` WHERE \`kind\` = 'clone' AND \`status\` = 'expired'`,
  )) as any[]

  const purgedTenantIds: number[] = []
  const failed: CleanupFailure[] = []
  for (const r of rows) {
    try {
      await purgeOne(r, actor)
      purgedTenantIds.push(Number(r.tenant_id))
    } catch (err: any) {
      failed.push({ demoId: Number(r.id), tenantId: Number(r.tenant_id), error: String(err?.message ?? err).slice(0, 300) })
    }
  }
  return { expired, purged: purgedTenantIds.length, purgedTenantIds, failed }
}

/** Operator control: expire (if needed) and purge exactly one clone. */
export async function cleanupDemoTenant(actor: Actor, id: number): Promise<DemoTenant> {
  await ensureDemoTenantSchema()
  const demo = await requireClone(id)
  if (demo.status === "active") {
    await expireOne({ id: demo.id, tenant_id: demo.tenantId, label: demo.label }, actor, "manual_cleanup")
  }
  const rows = (await query(`SELECT * FROM \`demo_tenants\` WHERE \`id\` = ? LIMIT 1`, [id])) as any[]
  try {
    await purgeOne(rows[0], actor)
  } catch (err: any) {
    throw new DemoTenantError(`Cleanup failed: ${err?.message ?? "unknown error"}`, 409)
  }
  return (await getDemoTenant(id))!
}

/** True when this tenant is the active demo template (guards generic tenant deletion). */
export async function isActiveDemoTemplateTenant(tenantId: number): Promise<boolean> {
  const t = await getTemplateRow()
  return !!t && t.tenantId === tenantId
}

// ---------------------------------------------------------------------------
// Copy / purge engine
// ---------------------------------------------------------------------------

/** Copy curated demo-safe rows from the template. Errors propagate (no silent partial clones). */
async function copyDemoData(fromTenantId: number, toTenantId: number): Promise<Record<string, number>> {
  if (fromTenantId === toTenantId) throw new Error("source and target tenant must differ")
  const copied: Record<string, number> = {}
  for (const spec of DEMO_CLONE_TABLES) {
    const rows = (await query(`SELECT * FROM \`${spec.table}\` WHERE \`tenant_id\` = ?`, [fromTenantId])) as any[]
    let n = 0
    for (const src of rows) {
      await insertRow(spec.table, buildClonedRow(spec, src, toTenantId))
      n++
    }
    copied[spec.table] = n
  }
  return copied
}

async function deleteDemoData(tenantId: number): Promise<void> {
  for (const spec of DEMO_CLONE_TABLES) {
    await query(`DELETE FROM \`${spec.table}\` WHERE \`tenant_id\` = ?`, [tenantId])
  }
}

const IGNORABLE_ERRNO = new Set([1146 /* no such table */, 1054 /* no such column */])
const FK_ERRNO = new Set([1451, 1217])

/**
 * Delete every tenant-owned row of a demo clone. Tables absent from this
 * install are skipped; FK-ordering conflicts are retried over several passes.
 */
async function purgeTenantData(tenantId: number): Promise<void> {
  let pending = demoPurgeTables(TENANT_OWNED_TABLES)
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    const retry: string[] = []
    let lastErr: any = null
    for (const table of pending) {
      try {
        await query(`DELETE FROM \`${table}\` WHERE \`tenant_id\` = ?`, [tenantId])
      } catch (err: any) {
        if (IGNORABLE_ERRNO.has(Number(err?.errno))) continue
        if (FK_ERRNO.has(Number(err?.errno))) {
          retry.push(table)
          lastErr = err
          continue
        }
        throw err
      }
    }
    if (retry.length && pass === 3) throw lastErr
    pending = retry
  }
}

/** Remove a half-built clone (only ever a tenant this call just created). */
async function discardPartialClone(tenantId: number): Promise<void> {
  const tenant = await getTenantById(tenantId)
  if (!tenant || !isDemoCloneTenantRecord(tenant)) return
  await purgeTenantData(tenantId)
  await deleteTenant(tenantId)
}

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

function isDuplicateKey(err: any): boolean {
  return err?.code === "ER_DUP_ENTRY" || Number(err?.errno) === 1062
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return `${Date.now().toString(36)}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}
