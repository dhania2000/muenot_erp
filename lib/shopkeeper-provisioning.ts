import "server-only"
import type { PoolConnection } from "mysql2/promise"
/**
 * SPEC 1-19 (Shopkeeper provisioning) — the DB/orchestration layer.
 * ---------------------------------------------------------------------------
 * The single server-side place that turns an operator's "Add Shopkeeper" action
 * into a real, sign-in-ready SHOPKEEPER customer. It REUSES the existing
 * platform building blocks rather than duplicating them:
 *
 *   - tenants + tenant_type            → lib/tenant-service.ts
 *   - shopkeeper_profiles              → lib/shopkeeper.ts
 *   - users / owner + password hashing → lib/user-lifecycle.ts + lib/password.ts
 *   - platform / tenant roles          → lib/platform-roles.ts (tenant_owner)
 *   - plans + subscriptions            → lib/platform-console.ts
 *   - entitlements                     → lib/platform/entitlement-guard.ts
 *   - mobile session revocation        → lib/mobile-auth.ts
 *   - platform audit                   → lib/platform-roles.ts#recordPlatformAudit
 *
 * The created credentials authenticate directly through the EXISTING mobile API
 * (POST /api/mobile/v1/auth/login) — there is no parallel Shopkeeper auth path.
 *
 * ATOMICITY (SPEC 3): all schema DDL self-heals FIRST (MySQL auto-commits DDL,
 * so it must live outside the transaction), then the tenant, shopkeeper
 * profile, owner user and subscription are written inside ONE transaction. Any
 * failure rolls everything back, so a tenant without an owner (or vice versa)
 * can never exist.
 *
 * SECURITY (SPEC 4/19): tenant_type is ALWAYS forced to SHOPKEEPER here — never
 * taken from client input. Plaintext passwords are only ever hashed, returned
 * once in the provisioning response, and never stored or logged.
 */
import { pool, query, tableColumns, withTransaction } from "@/lib/db"
import { ensureNotificationEngineSchema } from "@/lib/notification-engine/schema"
import { enqueueNotification, processNotification } from "@/lib/notification-engine/service"
import { hashPassword } from "@/lib/password"
import {
  ensureTenantSchema,
  getTenantById,
  getTenantBySlug,
  setTenantStatus,
  type Tenant,
  type TenantStatus,
} from "@/lib/tenant-service"
import { ensureShopkeeperSchema, getShopkeeperProfile, type ShopkeeperProfile } from "@/lib/shopkeeper"
import { ensureUserLifecycleSchema } from "@/lib/user-lifecycle"
import { ensureSignupSchema } from "@/lib/tenant-registration"
import { ensurePlatformRoleSchema, recordPlatformAudit } from "@/lib/platform-roles"
import {
  changeSubscriptionPlan,
  ensurePlatformConsoleSchema,
  getSubscriptionForTenant,
  listPlans,
  setSubscriptionStatus,
  type Plan,
  type TenantSubscription,
} from "@/lib/platform-console"
import { getEntitlementSnapshot, type EntitlementSnapshot } from "@/lib/platform/entitlement-guard"
import { revokeAllMobileSessionsForUser } from "@/lib/mobile-auth"
import {
  generateSecurePassword,
  isShopkeeperPlan,
  isTrialPlan,
  normalizePhone,
  normalizeShopkeeperInput,
  slugifyBusinessName,
  validatePasswordPolicy,
  type RawShopkeeperInput,
  type NormalizedShopkeeperInput,
  type ShopkeeperFieldError,
} from "@/lib/shopkeeper-provisioning-core"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ShopkeeperProvisioningError extends Error {
  status: number
  fieldErrors?: ShopkeeperFieldError[]
  constructor(message: string, status = 400, fieldErrors?: ShopkeeperFieldError[]) {
    super(message)
    this.name = "ShopkeeperProvisioningError"
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

export type ProvisionActor = { userId: number; email?: string | null }

const DEFAULT_TRIAL_DAYS = 14
const iso = (d: Date) => d.toISOString().slice(0, 10)
function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}
function addMonths(d: Date, months: number): Date {
  const out = new Date(d)
  out.setMonth(out.getMonth() + months)
  return out
}

// ---------------------------------------------------------------------------
// Schema readiness (all DDL runs before any transaction)
// ---------------------------------------------------------------------------

let columnEnsured: Promise<void> | null = null
async function ensureOwnerColumns(): Promise<void> {
  // `must_change_password` ships in the base users table, but guard defensively
  // for installs that predate it — additive/nullable, never destructive.
  const cols = await tableColumns("users")
  if (!cols.has("must_change_password")) {
    await query("ALTER TABLE `users` ADD COLUMN `must_change_password` TINYINT(1) NOT NULL DEFAULT 0")
  }
}

/** Make sure every table/column this module writes exists. Cached per process. */
export async function ensureShopkeeperProvisioningSchema(): Promise<void> {
  await ensureTenantSchema()
  await ensureSignupSchema() // adds users.mobile + tenants.onboarding_state (+ tenant schema)
  await ensureUserLifecycleSchema() // adds lifecycle_state, email_verified_at, activated_at, …
  await ensurePlatformRoleSchema() // adds users.platform_role / tenant_role
  await ensureShopkeeperSchema() // shopkeeper_profiles
  await ensurePlatformConsoleSchema() // platform_plans + tenant_subscriptions (+ seeds)
  if (!columnEnsured) {
    columnEnsured = ensureOwnerColumns().catch((err) => {
      columnEnsured = null
      throw err
    })
  }
  await columnEnsured
}
const ensureAllSchema = ensureShopkeeperProvisioningSchema

async function findUniqueSlug(businessName: string): Promise<string> {
  const base = slugifyBusinessName(businessName)
  let candidate = base
  let n = 1
  while (await getTenantBySlug(candidate)) {
    n += 1
    const suffix = `-${n}`
    candidate = `${base.slice(0, 90 - suffix.length)}${suffix}`
    if (n > 50) {
      candidate = `${base.slice(0, 80)}-${Date.now().toString(36)}`
      break
    }
  }
  return candidate
}

export async function requireShopkeeperPlan(planCode: string): Promise<Plan> {
  const plans = await listPlans()
  const plan = plans.find((p) => p.code === planCode)
  if (!plan) throw new ShopkeeperProvisioningError("Unknown subscription plan", 400, [{ field: "planCode", message: "Unknown subscription plan" }])
  if (!plan.is_active) throw new ShopkeeperProvisioningError("That plan is not active", 400, [{ field: "planCode", message: "That plan is not active" }])
  if (!isShopkeeperPlan(plan)) {
    throw new ShopkeeperProvisioningError("Selected plan is not a Shopkeeper plan", 400, [
      { field: "planCode", message: "Select a Shopkeeper plan" },
    ])
  }
  return plan
}

/** The Shopkeeper plans an operator may choose from (for the Add/Manage UI). */
export async function listShopkeeperPlans(): Promise<Plan[]> {
  await ensurePlatformConsoleSchema()
  const plans = await listPlans()
  return plans.filter((p) => p.is_active && isShopkeeperPlan(p))
}

// ---------------------------------------------------------------------------
// Provisioning (SPEC 2/3/4/5/7/8/9)
// ---------------------------------------------------------------------------

export type ProvisionResult = {
  tenantId: number
  tenantSlug: string
  ownerUserId: number
  businessName: string
  ownerName: string
  ownerEmail: string
  planCode: string
  planName: string
  subscriptionStatus: TenantSubscription["status"]
  trialEnd: string | null
  /** Plaintext — returned ONCE in this response only; never stored or logged. */
  password: string
  passwordGenerated: boolean
}

/** Shared transactional write for operator creation and approved applications. */
export async function insertShopkeeperRecords(
  conn: PoolConnection,
  input: NormalizedShopkeeperInput,
  passwordHash: string,
  plan: Plan,
  actor: ProvisionActor,
  options: { channel: string; businessCategory?: string | null; state?: string | null; city?: string | null; postalCode?: string | null; emailVerified?: boolean } = { channel: "platform_shopkeeper_console" },
): Promise<{ tenantId: number; ownerUserId: number; slug: string; subscriptionStatus: TenantSubscription["status"]; trialEnd: string | null }> {
  const slug = await findUniqueSlug(input.businessName)
  const now = new Date()
  const trial = isTrialPlan(plan) || input.startTrial
  const subscriptionStatus: TenantSubscription["status"] = trial ? "trialing" : "active"
  const trialEnd = trial ? iso(addDays(now, DEFAULT_TRIAL_DAYS)) : null
  const settings = {
    profile: { displayName: input.displayName, businessMobile: input.businessMobile },
    localization: { country: input.country, timezone: input.timezone, currency: input.currency },
    provisioning: { provisionedByUserId: actor.userId, provisionedAt: now.toISOString(), channel: options.channel },
  }
  const [tenantRes] = await conn.query<any>(
    `INSERT INTO tenants (name,slug,status,onboarding_state,tenant_type,deployment_model,plan,settings,is_platform_owner)
     VALUES (?,?,'active','active','SHOPKEEPER','shared_database',?,?,0)`,
    [input.businessName, slug, plan.code, JSON.stringify(settings)],
  )
  const tenantId = Number(tenantRes.insertId)
  await conn.query(
    `INSERT INTO shopkeeper_profiles
      (tenant_id,shop_name,owner_name,business_category,email,phone,country,state,city,pin_code,timezone,currency)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tenantId, input.displayName ?? input.businessName, input.ownerName, options.businessCategory ?? null,
      input.ownerEmail, input.businessMobile, input.country, options.state ?? null, options.city ?? null,
      options.postalCode ?? null, input.timezone, input.currency],
  )
  const [userRes] = await conn.query<any>(
    `INSERT INTO users
      (tenant_id,name,email,mobile,password_hash,role,tenant_role,platform_role,designation,status,lifecycle_state,must_change_password,email_verified_at,activated_at)
     VALUES (?,?,?,?,?,'admin','tenant_owner','none','Shop Owner','active','active',?,?,NOW())`,
    [tenantId, input.ownerName, input.ownerEmail, input.ownerMobile, passwordHash, input.generatePassword ? 1 : 0, options.emailVerified === false ? null : now],
  )
  const ownerUserId = Number(userRes.insertId)
  await conn.query(
    `INSERT INTO tenant_subscriptions
      (tenant_id,plan_code,status,seats,mrr,currency,current_period_start,current_period_end,trial_end)
     VALUES (?,?,?,1,?,?,?,?,?)`,
    [tenantId, plan.code, subscriptionStatus, plan.price_monthly, plan.currency, iso(now), iso(addMonths(now, 1)), trialEnd],
  )
  return { tenantId, ownerUserId, slug, subscriptionStatus, trialEnd }
}

export async function provisionShopkeeper(raw: RawShopkeeperInput, actor: ProvisionActor): Promise<ProvisionResult> {
  const normalized = normalizeShopkeeperInput(raw)
  if (!normalized.ok) {
    throw new ShopkeeperProvisioningError("Please correct the highlighted fields", 400, normalized.errors)
  }
  const input = normalized.value

  await ensureShopkeeperProvisioningSchema()

  // Plan + trial resolution (backend authoritative — SPEC 7/8).
  const plan = await requireShopkeeperPlan(input.planCode)

  // Duplicate email — email is globally unique across the users table (SPEC 17).
  const existing = await query<{ id: number }[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [input.ownerEmail])
  if (existing[0]) {
    throw new ShopkeeperProvisioningError("An account with this email already exists.", 409, [
      { field: "ownerEmail", message: "An account with this email already exists." },
    ])
  }

  const passwordGenerated = input.generatePassword
  const plaintext = passwordGenerated ? generateSecurePassword(14) : input.password!
  const passwordHash = await hashPassword(plaintext)

  // --- ONE transaction: tenant + profile + owner + subscription (SPEC 3) ---
  const conn = await pool.getConnection()
  let created: Awaited<ReturnType<typeof insertShopkeeperRecords>>
  try {
    await conn.beginTransaction()

    created = await insertShopkeeperRecords(conn, input, passwordHash, plan, actor)

    await conn.commit()
  } catch (err) {
    await conn.rollback().catch(() => {})
    const code = (err as { code?: string })?.code
    if (code === "ER_DUP_ENTRY") {
      throw new ShopkeeperProvisioningError("That email or shop was just registered. Please try again.", 409)
    }
    throw err
  } finally {
    conn.release()
  }

  // Audit (never blocks the primary action; never records the plaintext).
  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "provision_shopkeeper",
    targetTenantId: created.tenantId,
    targetUserId: created.ownerUserId,
    detail: {
      businessName: input.businessName,
      slug: created.slug,
      ownerEmail: input.ownerEmail,
      planCode: plan.code,
      subscriptionStatus: created.subscriptionStatus,
      trial: created.subscriptionStatus === "trialing",
      passwordGenerated,
    },
  })

  return {
    tenantId: created.tenantId,
    tenantSlug: created.slug,
    ownerUserId: created.ownerUserId,
    businessName: input.businessName,
    ownerName: input.ownerName,
    ownerEmail: input.ownerEmail,
    planCode: plan.code,
    planName: plan.name,
    subscriptionStatus: created.subscriptionStatus,
    trialEnd: created.trialEnd,
    password: plaintext,
    passwordGenerated,
  }
}

// ---------------------------------------------------------------------------
// Guard: an [id] route only operates on real SHOPKEEPER tenants (SPEC 4/19).
// ---------------------------------------------------------------------------

async function requireShopkeeperTenant(id: number): Promise<Tenant> {
  await ensureTenantSchema()
  const tenant = await getTenantById(id)
  if (!tenant || tenant.tenant_type !== "SHOPKEEPER") {
    throw new ShopkeeperProvisioningError("Shopkeeper not found", 404)
  }
  return tenant
}

/** Load the single owner (tenant_owner) user for a shopkeeper tenant. */
async function getOwnerUser(tenantId: number): Promise<{ id: number; name: string; email: string; mobile: string | null } | null> {
  const rows = await query<any[]>(
    `SELECT id, name, email, mobile FROM \`users\`
      WHERE tenant_id = ? AND tenant_role = 'tenant_owner'
      ORDER BY id ASC LIMIT 1`,
    [tenantId],
  )
  const r = rows[0]
  return r ? { id: Number(r.id), name: r.name, email: r.email, mobile: r.mobile ?? null } : null
}

// ---------------------------------------------------------------------------
// Listing (SPEC 1)
// ---------------------------------------------------------------------------

export type ShopkeeperListRow = {
  tenantId: number
  slug: string
  businessName: string
  shopName: string | null
  ownerName: string | null
  ownerEmail: string | null
  ownerMobile: string | null
  businessMobile: string | null
  planCode: string | null
  planName: string | null
  subscriptionStatus: string | null
  accountStatus: TenantStatus
  whatsappConnected: boolean
  createdAt: string
  lastLoginAt: string | null
}

export async function listShopkeepers(): Promise<ShopkeeperListRow[]> {
  await ensureAllSchema()
  const rows = await query<any[]>(
    `SELECT t.id, t.name, t.slug, t.status, t.created_at,
            p.shop_name, p.owner_name, p.phone AS business_phone,
            s.plan_code, s.status AS sub_status,
            pl.name AS plan_name,
            u.id AS owner_id, u.name AS owner_user_name, u.email AS owner_email, u.mobile AS owner_mobile
       FROM \`tenants\` t
       LEFT JOIN \`shopkeeper_profiles\` p ON p.tenant_id = t.id
       LEFT JOIN \`tenant_subscriptions\` s ON s.tenant_id = t.id
       LEFT JOIN \`platform_plans\` pl ON pl.code = s.plan_code
       LEFT JOIN \`users\` u
              ON u.tenant_id = t.id AND u.tenant_role = 'tenant_owner'
             AND u.id = (SELECT MIN(id) FROM \`users\` WHERE tenant_id = t.id AND tenant_role = 'tenant_owner')
      WHERE t.tenant_type = 'SHOPKEEPER'
      ORDER BY t.created_at DESC, t.id DESC`,
  )
  if (rows.length === 0) return []

  const ids = rows.map((r) => Number(r.id))
  const whatsapp = await whatsappConnectedMap(ids)
  const lastLogin = await lastLoginMap(ids)

  return rows.map((r) => ({
    tenantId: Number(r.id),
    slug: r.slug,
    businessName: r.name,
    shopName: r.shop_name ?? null,
    ownerName: r.owner_name ?? r.owner_user_name ?? null,
    ownerEmail: r.owner_email ?? null,
    ownerMobile: r.owner_mobile ?? null,
    businessMobile: r.business_phone ?? null,
    planCode: r.plan_code ?? null,
    planName: r.plan_name ?? r.plan_code ?? null,
    subscriptionStatus: r.sub_status ?? null,
    accountStatus: r.status as TenantStatus,
    whatsappConnected: whatsapp.get(Number(r.id)) ?? false,
    createdAt: r.created_at,
    lastLoginAt: lastLogin.get(Number(r.id)) ?? null,
  }))
}

/** WhatsApp connection state per tenant (presence of a phone number id). */
async function whatsappConnectedMap(tenantIds: number[]): Promise<Map<number, boolean>> {
  const map = new Map<number, boolean>()
  if (tenantIds.length === 0) return map
  try {
    const cols = await tableColumns("marketing_whatsapp_integration")
    if (!cols.has("tenant_id") || !cols.has("phone_number_id")) return map
    const placeholders = tenantIds.map(() => "?").join(",")
    const rows = await query<any[]>(
      `SELECT tenant_id, phone_number_id FROM \`marketing_whatsapp_integration\` WHERE tenant_id IN (${placeholders}) ${cols.has("released_at") ? "AND released_at IS NULL" : ""}`,
      tenantIds,
    )
    for (const r of rows) map.set(Number(r.tenant_id), Boolean(r.phone_number_id))
  } catch {
    /* no integration table yet — everyone reported as not connected */
  }
  return map
}

/** Most recent mobile sign-in per tenant, when the session table exists. */
async function lastLoginMap(tenantIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (tenantIds.length === 0) return map
  try {
    const cols = await tableColumns("mobile_sessions")
    if (!cols.has("tenant_id")) return map
    const placeholders = tenantIds.map(() => "?").join(",")
    const rows = await query<any[]>(
      `SELECT tenant_id, MAX(last_active_at) AS last_active
         FROM \`mobile_sessions\` WHERE tenant_id IN (${placeholders}) GROUP BY tenant_id`,
      tenantIds,
    )
    for (const r of rows) if (r.last_active) map.set(Number(r.tenant_id), r.last_active)
  } catch {
    /* no mobile sessions table yet */
  }
  return map
}

// ---------------------------------------------------------------------------
// Detail / 360 (SPEC 11)
// ---------------------------------------------------------------------------

export type ShopkeeperDetail = {
  tenant: {
    id: number
    name: string
    slug: string
    status: TenantStatus
    tenantType: string
    createdAt: string
    updatedAt: string
    settings: Record<string, unknown> | null
  }
  profile: ShopkeeperProfile | null
  owner: { id: number; name: string; email: string; mobile: string | null } | null
  subscription: TenantSubscription | null
  planName: string | null
  entitlements: EntitlementSnapshot
  whatsapp: { connected: boolean; status: "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "ACTION_REQUIRED"; phoneNumber: string | null; quality: string | null; wabaId: string | null; phoneNumberId: string | null; connectedAt: string | null }
  activity: { at: string; actor: string | null; action: string; detail: Record<string, unknown> | null }[]
  lastLoginAt: string | null
}

export async function getShopkeeperDetail(id: number): Promise<ShopkeeperDetail> {
  await ensureAllSchema()
  const tenant = await requireShopkeeperTenant(id)

  const [profile, owner, subscription, entitlements] = await Promise.all([
    getShopkeeperProfile(id),
    getOwnerUser(id),
    getSubscriptionForTenant(id),
    getEntitlementSnapshot(id),
  ])

  const planName = subscription
    ? (await listPlans()).find((p) => p.code === subscription.plan_code)?.name ?? subscription.plan_code
    : null

  const whatsapp = await whatsappDetail(id)
  const activity = await recentActivity(id)
  const lastLogin = (await lastLoginMap([id])).get(id) ?? null

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      tenantType: tenant.tenant_type,
      createdAt: tenant.created_at,
      updatedAt: tenant.updated_at,
      settings: tenant.settings,
    },
    profile,
    owner,
    subscription,
    planName,
    entitlements,
    whatsapp,
    activity,
    lastLoginAt: lastLogin,
  }
}

async function whatsappDetail(tenantId: number): Promise<ShopkeeperDetail["whatsapp"]> {
  const empty: ShopkeeperDetail["whatsapp"] = { connected: false, status: "NOT_CONNECTED", phoneNumber: null, quality: null, wabaId: null, phoneNumberId: null, connectedAt: null }
  try {
    const cols = await tableColumns("marketing_whatsapp_integration")
    if (!cols.has("tenant_id")) return empty
    const rows = await query<any[]>(
      `SELECT id,display_phone_number,phone_number_id,waba_id,quality_rating,connected_at FROM \`marketing_whatsapp_integration\` WHERE tenant_id = ? ${cols.has("released_at") ? "AND released_at IS NULL" : ""} ORDER BY connected_at DESC LIMIT 1`,
      [tenantId],
    )
    if (rows[0]) {
      const [registration] = await query<{ cloud_api_registered: number; registration_status: string }[]>(
        "SELECT cloud_api_registered,registration_status FROM marketing_whatsapp_registration WHERE tenant_id=? AND connection_id=? LIMIT 1", [tenantId,rows[0].id],
      ).catch(() => [] as { cloud_api_registered: number; registration_status: string }[])
      const status = registration?.cloud_api_registered ? "CONNECTED" : registration && ["failed","not_registered","migration_required"].includes(registration.registration_status) ? "ACTION_REQUIRED" : "CONNECTING"
      return {
        connected: status === "CONNECTED", status,
        phoneNumber: rows[0].display_phone_number ?? null,
        quality: rows[0].quality_rating ?? null,
        wabaId: rows[0].waba_id ?? null,
        phoneNumberId: rows[0].phone_number_id ?? null,
        connectedAt: rows[0].connected_at ?? null,
      }
    }
  } catch {
    /* not connected */
  }
  return empty
}

/**
 * Merge the platform audit and the tenant's user-lifecycle events into one
 * activity feed. NEVER surfaces secrets — audit detail is written by the
 * platform helpers which already exclude tokens/passwords.
 */
async function recentActivity(tenantId: number): Promise<ShopkeeperDetail["activity"]> {
  const out: ShopkeeperDetail["activity"] = []
  try {
    const rows = await query<any[]>(
      `SELECT created_at, actor_email, action, detail FROM \`platform_admin_audit\`
        WHERE target_tenant_id = ? ORDER BY id DESC LIMIT 25`,
      [tenantId],
    )
    for (const r of rows) {
      out.push({ at: r.created_at, actor: r.actor_email ?? null, action: r.action, detail: parseJson(r.detail) })
    }
  } catch {
    /* audit table missing */
  }
  try {
    const rows = await query<any[]>(
      `SELECT created_at, actor_email, action, detail FROM \`user_lifecycle_events\`
        WHERE tenant_id = ? ORDER BY id DESC LIMIT 25`,
      [tenantId],
    )
    for (const r of rows) {
      out.push({ at: r.created_at, actor: r.actor_email ?? null, action: r.action, detail: parseJson(r.detail) })
    }
  } catch {
    /* lifecycle table missing */
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30)
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === "object") return v as Record<string, unknown>
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Edit (SPEC 14)
// ---------------------------------------------------------------------------

export type UpdateShopkeeperPatch = {
  businessName?: unknown
  ownerName?: unknown
  businessMobile?: unknown
  ownerMobile?: unknown
  timezone?: unknown
  currency?: unknown
  country?: unknown
  displayName?: unknown
  ownerEmail?: unknown
}

export async function updateShopkeeper(id: number, patch: UpdateShopkeeperPatch, actor: ProvisionActor): Promise<void> {
  await ensureAllSchema()
  await requireShopkeeperTenant(id)
  const owner = await getOwnerUser(id)

  const changed: Record<string, unknown> = {}

  // Tenant display name / shop name.
  if (typeof patch.businessName === "string") {
    const businessName = patch.businessName.trim()
    if (businessName.length < 2 || businessName.length > 150) {
      throw new ShopkeeperProvisioningError("Business name must be 2-150 characters", 400, [
        { field: "businessName", message: "Business name must be 2-150 characters" },
      ])
    }
    await query("UPDATE `tenants` SET `name` = ? WHERE `id` = ?", [businessName, id])
    await query("UPDATE `shopkeeper_profiles` SET `shop_name` = ? WHERE `tenant_id` = ?", [businessName, id])
    changed.businessName = businessName
  }

  const profileSets: string[] = []
  const profileVals: unknown[] = []
  const setProfile = (col: string, val: unknown) => {
    profileSets.push(`\`${col}\` = ?`)
    profileVals.push(val)
  }

  if (typeof patch.displayName === "string") setProfile("shop_name", patch.displayName.trim().slice(0, 150) || null)
  if (patch.businessMobile !== undefined) {
    const mobile = normalizePhone(patch.businessMobile)
    setProfile("phone", mobile)
    changed.businessMobile = mobile
  }
  if (typeof patch.timezone === "string") setProfile("timezone", patch.timezone.trim().slice(0, 80) || null)
  if (typeof patch.currency === "string") {
    const currency = patch.currency.trim().toUpperCase()
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      throw new ShopkeeperProvisioningError("Currency must be a 3-letter code", 400, [
        { field: "currency", message: "Currency must be a 3-letter code" },
      ])
    }
    setProfile("currency", currency || null)
  }
  if (typeof patch.country === "string") setProfile("country", patch.country.trim().slice(0, 120) || null)
  if (typeof patch.ownerName === "string") setProfile("owner_name", patch.ownerName.trim().slice(0, 150) || null)

  if (profileSets.length > 0) {
    await query(`UPDATE \`shopkeeper_profiles\` SET ${profileSets.join(", ")} WHERE \`tenant_id\` = ?`, [...profileVals, id])
  }

  // Owner user fields.
  if (owner) {
    if (typeof patch.ownerName === "string") {
      const ownerName = patch.ownerName.trim()
      if (ownerName.length < 2) {
        throw new ShopkeeperProvisioningError("Owner name is required", 400, [{ field: "ownerName", message: "Owner name is required" }])
      }
      await query("UPDATE `users` SET `name` = ? WHERE `id` = ? AND `tenant_id` = ?", [ownerName, owner.id, id])
      changed.ownerName = ownerName
    }
    if (patch.ownerMobile !== undefined) {
      const mobile = normalizePhone(patch.ownerMobile)
      await query("UPDATE `users` SET `mobile` = ? WHERE `id` = ? AND `tenant_id` = ?", [mobile, owner.id, id])
      changed.ownerMobile = mobile
    }
    // Email is an authentication identifier — change carefully with a global
    // uniqueness check (SPEC 14/17).
    if (typeof patch.ownerEmail === "string" && patch.ownerEmail.trim().toLowerCase() !== owner.email) {
      const email = patch.ownerEmail.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ShopkeeperProvisioningError("A valid owner email is required", 400, [{ field: "ownerEmail", message: "A valid owner email is required" }])
      }
      const dupe = await query<{ id: number }[]>("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1", [email, owner.id])
      if (dupe[0]) {
        throw new ShopkeeperProvisioningError("An account with this email already exists.", 409, [
          { field: "ownerEmail", message: "An account with this email already exists." },
        ])
      }
      await query("UPDATE `users` SET `email` = ? WHERE `id` = ? AND `tenant_id` = ?", [email, owner.id, id])
      await query("UPDATE `shopkeeper_profiles` SET `email` = ? WHERE `tenant_id` = ?", [email, id])
      changed.ownerEmail = email
    }
  }

  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "update_shopkeeper",
    targetTenantId: id,
    targetUserId: owner?.id ?? null,
    detail: changed,
  })
}

// ---------------------------------------------------------------------------
// Account status (SPEC 12)
// ---------------------------------------------------------------------------

/**
 * Suspend / reactivate / deactivate a shopkeeper. Enforcement is server-side:
 * a suspended (non-active) tenant is rejected by the mobile auth layer on every
 * request — the Android app cannot bypass it (SPEC 6/12). Reuses the existing
 * tenant lifecycle primitive.
 */
export async function setShopkeeperStatus(id: number, status: TenantStatus, actor: ProvisionActor): Promise<Tenant> {
  await ensureAllSchema()
  const previous = await requireShopkeeperTenant(id)
  const tenant = await setTenantStatus(id, status)

  // Keep the console subscription status roughly aligned so the roster reads
  // correctly, without corrupting an in-progress trial.
  const sub = await getSubscriptionForTenant(id)
  if (sub) {
    if (status === "active" && sub.status === "past_due") await setSubscriptionStatus(id, "active")
    else if (status !== "active" && sub.status === "active") await setSubscriptionStatus(id, "past_due")
  }

  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: status === "active" ? "activate_shopkeeper" : status === "suspended" ? "suspend_shopkeeper" : "deactivate_shopkeeper",
    targetTenantId: id,
    detail: { status },
  })
  if (status === "suspended" && previous.status !== "suspended") {
    try {
      const owner = await getOwnerUser(id)
      if (owner) {
        await ensureNotificationEngineSchema()
        const ids = await withTransaction(async conn => [
          await enqueueNotification(conn, { tenantId: id, userId: owner.id, channel: "in_app", key: `shopkeeper-suspended:${id}:${Date.now()}`, title: "Account suspended", body: "Your Muenot Shopkeeper account has been suspended." }),
          await enqueueNotification(conn, { tenantId: id, userId: owner.id, channel: "push", key: `shopkeeper-suspended:${id}:${Date.now()}`, title: "Account suspended", body: "Your Muenot Shopkeeper account has been suspended." }),
        ])
        await Promise.all(ids.map(deliveryId => processNotification(deliveryId)))
      }
    } catch { /* suspension is authoritative even when a notification provider is down */ }
  }
  return tenant
}

// ---------------------------------------------------------------------------
// Subscription / plan (SPEC 7)
// ---------------------------------------------------------------------------

export async function changeShopkeeperPlan(id: number, planCode: string, actor: ProvisionActor): Promise<void> {
  await ensureAllSchema()
  await requireShopkeeperTenant(id)
  const plan = await requireShopkeeperPlan(String(planCode).toLowerCase())
  await changeSubscriptionPlan(id, plan.code)
  // Keep tenants.plan in sync so entitlement re-derivation stays correct.
  await query("UPDATE `tenants` SET `plan` = ? WHERE `id` = ?", [plan.code, id])
  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "change_shopkeeper_plan",
    targetTenantId: id,
    detail: { planCode: plan.code },
  })
}

// ---------------------------------------------------------------------------
// Password reset (SPEC 13)
// ---------------------------------------------------------------------------

export type ResetPasswordResult = {
  ownerUserId: number
  ownerEmail: string
  password: string
  passwordGenerated: boolean
  revokedSessions: number
}

export async function resetShopkeeperOwnerPassword(
  id: number,
  opts: { generate?: boolean; password?: string },
  actor: ProvisionActor,
): Promise<ResetPasswordResult> {
  await ensureAllSchema()
  await requireShopkeeperTenant(id)
  const owner = await getOwnerUser(id)
  if (!owner) throw new ShopkeeperProvisioningError("This shopkeeper has no owner account", 409)

  const generate = opts.generate !== false && !opts.password
  let plaintext: string
  if (generate) {
    plaintext = generateSecurePassword(14)
  } else {
    const provided = opts.password ?? ""
    const pwError = validatePasswordPolicy(provided)
    if (pwError) throw new ShopkeeperProvisioningError(pwError, 400, [{ field: "password", message: pwError }])
    plaintext = provided
  }
  const passwordHash = await hashPassword(plaintext)

  await query("UPDATE `users` SET `password_hash` = ?, `must_change_password` = 1 WHERE `id` = ? AND `tenant_id` = ?", [
    passwordHash,
    owner.id,
    id,
  ])

  // A credential change immediately invalidates every signed-in device
  // (existing security policy — SPEC 13/19).
  const revoked = await revokeAllMobileSessionsForUser(owner.id, "password_reset")

  await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: "reset_shopkeeper_password",
    targetTenantId: id,
    targetUserId: owner.id,
    detail: { passwordGenerated: generate, revokedSessions: revoked },
  })

  return { ownerUserId: owner.id, ownerEmail: owner.email, password: plaintext, passwordGenerated: generate, revokedSessions: revoked }
}
