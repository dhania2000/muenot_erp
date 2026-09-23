import "server-only"
/**
 * Enterprise tenant / organization onboarding.
 * ---------------------------------------------------------------------------
 * A tenant is provisioned in ONE place — lib/tenant-service.ts#createTenant.
 * That primitive only takes name/slug/plan/deployment_model, which is fine for
 * an operator "quick create" but far short of an enterprise onboarding (legal
 * entity, localization, tax, branding, the first admin user, storage and
 * security posture, …).
 *
 * This module adds a *durable, resumable* onboarding record that:
 *   - captures the full organization profile as a single JSON draft,
 *   - is saved step-by-step so a half-finished onboarding can be resumed
 *     later (status `draft` / `in_progress`),
 *   - is finalized by a backend orchestrator that creates the tenant, seeds
 *     the first admin (owner) user, and stamps the whole config onto the
 *     tenant's settings (status `completed`),
 *   - records the exact failure and any partially-created ids when a step
 *     blows up (status `failed`), so finalize is idempotent and re-runnable
 *     without duplicating the tenant or the admin user.
 *
 * The schema self-heals at runtime (same pattern as tenant-service /
 * platform-roles) so existing installs converge without a manual migration.
 */
import { pool, query } from "@/lib/db"
import { createTenant, getTenantBySlug, type DeploymentModel } from "@/lib/tenant-service"
import { hashPassword, generateTempPassword } from "@/lib/password"
import { recordPlatformAudit } from "@/lib/platform-roles"

// ---------------------------------------------------------------------------
// Types — the onboarding draft payload
// ---------------------------------------------------------------------------

export type OnboardingStatus = "draft" | "in_progress" | "completed" | "failed"

/** The ordered wizard steps. The index into this array is `current_step`. */
export const ONBOARDING_STEPS = [
  "company",
  "localization",
  "tax_address",
  "branding",
  "admin",
  "domain_subscription",
  "storage_security",
  "review",
] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "AED", "JPY", "CNY"] as const
export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"] as const
export const FISCAL_YEAR_STARTS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const
export const PLANS = ["starter", "growth", "enterprise"] as const
export const DEPLOYMENT_MODELS: DeploymentModel[] = [
  "shared_database",
  "separate_schema",
  "dedicated_database",
]
export const PASSWORD_POLICIES = ["standard", "strong", "enterprise"] as const

/** The complete, partial-friendly onboarding payload. Every field optional so
 * a draft can be saved at any point; requirements are enforced at finalize. */
export type OnboardingData = {
  // Company
  companyName?: string
  legalEntity?: string
  industry?: string
  companySize?: string
  // Localization
  country?: string
  currency?: string
  timezone?: string
  fiscalYearStart?: string
  language?: string
  // Tax & address
  taxId?: string
  taxScheme?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  addressCountry?: string
  // Branding
  primaryColor?: string
  accentColor?: string
  logoUrl?: string
  // Admin user
  adminName?: string
  adminEmail?: string
  // Domain & subscription
  slug?: string
  customDomain?: string
  plan?: string
  deploymentModel?: DeploymentModel
  // Storage & security
  storageRegion?: string
  storageQuotaGb?: number
  requireMfa?: boolean
  passwordPolicy?: string
  sessionTimeoutMinutes?: number
  ipAllowlist?: string
}

export type OnboardingRecord = {
  id: number
  status: OnboardingStatus
  currentStep: number
  data: OnboardingData
  createdTenantId: number | null
  createdAdminUserId: number | null
  errorMessage: string | null
  createdBy: number | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

type Row = {
  id: number
  status: OnboardingStatus
  current_step: number
  data: string | OnboardingData | null
  created_tenant_id: number | null
  created_admin_user_id: number | null
  error_message: string | null
  created_by: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

function mapRow(row: Row): OnboardingRecord {
  let data: OnboardingData = {}
  if (row.data) {
    if (typeof row.data === "string") {
      try {
        data = JSON.parse(row.data)
      } catch {
        data = {}
      }
    } else {
      data = row.data
    }
  }
  return {
    id: Number(row.id),
    status: row.status,
    currentStep: Number(row.current_step),
    data,
    createdTenantId: row.created_tenant_id != null ? Number(row.created_tenant_id) : null,
    createdAdminUserId: row.created_admin_user_id != null ? Number(row.created_admin_user_id) : null,
    errorMessage: row.error_message,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_onboarding\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`status\` ENUM('draft','in_progress','completed','failed') NOT NULL DEFAULT 'draft',
      \`current_step\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
      \`data\` JSON DEFAULT NULL,
      \`created_tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`created_admin_user_id\` INT UNSIGNED DEFAULT NULL,
      \`error_message\` TEXT DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`completed_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_onboarding_status\` (\`status\`),
      KEY \`idx_onboarding_created_by\` (\`created_by\`),
      KEY \`idx_onboarding_tenant\` (\`created_tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

/** Ensure the onboarding table exists. Cached per process; safe to call often. */
export async function ensureOnboardingSchema(): Promise<void> {
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

export async function listOnboarding(): Promise<OnboardingRecord[]> {
  await ensureOnboardingSchema()
  const rows = await query<Row[]>(
    `SELECT * FROM \`tenant_onboarding\` ORDER BY
       FIELD(\`status\`,'failed','in_progress','draft','completed'), \`updated_at\` DESC`,
  )
  return rows.map(mapRow)
}

export async function getOnboarding(id: number): Promise<OnboardingRecord | null> {
  await ensureOnboardingSchema()
  const rows = await query<Row[]>(`SELECT * FROM \`tenant_onboarding\` WHERE \`id\` = ? LIMIT 1`, [id])
  return rows[0] ? mapRow(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Draft lifecycle
// ---------------------------------------------------------------------------

export async function createOnboarding(actorId: number | null): Promise<OnboardingRecord> {
  await ensureOnboardingSchema()
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`tenant_onboarding\` (\`status\`, \`current_step\`, \`data\`, \`created_by\`)
     VALUES ('draft', 0, ?, ?)`,
    [JSON.stringify({}), actorId],
  )
  const created = await getOnboarding(result.insertId)
  if (!created) throw new Error("Failed to load the onboarding draft that was just created")
  return created
}

export class OnboardingStateError extends Error {
  status: number
  constructor(message: string, status = 409) {
    super(message)
    this.name = "OnboardingStateError"
    this.status = status
  }
}

/**
 * Persist a wizard step. Merges the supplied partial data into the stored
 * draft (so each step only sends its own fields) and advances the furthest
 * step reached. A completed onboarding is immutable.
 */
export async function saveOnboardingStep(
  id: number,
  step: number,
  patch: Partial<OnboardingData>,
): Promise<OnboardingRecord> {
  await ensureOnboardingSchema()
  const current = await getOnboarding(id)
  if (!current) throw new OnboardingStateError("Onboarding session not found", 404)
  if (current.status === "completed") {
    throw new OnboardingStateError("This onboarding is already completed and can no longer be edited")
  }

  const merged = { ...current.data, ...sanitizeData(patch) }
  const nextStep = Math.max(current.currentStep, Math.min(step, ONBOARDING_STEPS.length - 1))
  // Any save moves a fresh/failed draft back into an editable in-progress state.
  const nextStatus: OnboardingStatus = "in_progress"

  await query(
    `UPDATE \`tenant_onboarding\`
        SET \`data\` = ?, \`current_step\` = ?, \`status\` = ?, \`error_message\` = NULL
      WHERE \`id\` = ?`,
    [JSON.stringify(merged), nextStep, nextStatus, id],
  )
  const updated = await getOnboarding(id)
  if (!updated) throw new Error("Failed to load the updated onboarding session")
  return updated
}

export async function deleteOnboarding(id: number): Promise<void> {
  await ensureOnboardingSchema()
  const current = await getOnboarding(id)
  if (!current) throw new OnboardingStateError("Onboarding session not found", 404)
  if (current.status === "completed") {
    throw new OnboardingStateError("Completed onboarding records are retained for audit and cannot be deleted")
  }
  await query(`DELETE FROM \`tenant_onboarding\` WHERE \`id\` = ?`, [id])
}

/** Keep only known keys and coerce obvious types before persisting. */
function sanitizeData(patch: Partial<OnboardingData>): Partial<OnboardingData> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (typeof v === "string") {
      const trimmed = v.trim()
      out[k] = trimmed === "" ? undefined : trimmed
    } else {
      out[k] = v
    }
  }
  return out as Partial<OnboardingData>
}

// ---------------------------------------------------------------------------
// Validation (enforced only at finalize)
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type FieldError = { field: keyof OnboardingData; message: string }

export function validateOnboarding(data: OnboardingData): FieldError[] {
  const errors: FieldError[] = []
  const req = (field: keyof OnboardingData, label: string) => {
    const v = data[field]
    if (v == null || (typeof v === "string" && v.trim() === "")) {
      errors.push({ field, message: `${label} is required` })
    }
  }

  req("companyName", "Company name")
  req("legalEntity", "Legal entity")
  req("industry", "Industry")
  req("companySize", "Company size")
  req("country", "Country")
  req("currency", "Currency")
  req("timezone", "Timezone")
  req("fiscalYearStart", "Fiscal year start")
  req("language", "Language")
  req("adminName", "Admin name")
  req("adminEmail", "Admin email")
  req("slug", "Subdomain / slug")
  req("plan", "Subscription plan")
  req("deploymentModel", "Deployment model")

  if (data.adminEmail && !EMAIL_RE.test(data.adminEmail.trim())) {
    errors.push({ field: "adminEmail", message: "Admin email is not a valid email address" })
  }
  if (data.slug && !SLUG_RE.test(data.slug.trim().toLowerCase())) {
    errors.push({
      field: "slug",
      message: "Slug must be 2-100 chars: lowercase letters, digits or hyphens",
    })
  }
  if (data.plan && !PLANS.includes(data.plan as (typeof PLANS)[number])) {
    errors.push({ field: "plan", message: "Unknown subscription plan" })
  }
  if (data.deploymentModel && !DEPLOYMENT_MODELS.includes(data.deploymentModel)) {
    errors.push({ field: "deploymentModel", message: "Unknown deployment model" })
  }
  if (data.storageQuotaGb != null && (!Number.isFinite(data.storageQuotaGb) || data.storageQuotaGb < 0)) {
    errors.push({ field: "storageQuotaGb", message: "Storage quota must be a positive number" })
  }
  if (
    data.sessionTimeoutMinutes != null &&
    (!Number.isFinite(data.sessionTimeoutMinutes) || data.sessionTimeoutMinutes < 5)
  ) {
    errors.push({ field: "sessionTimeoutMinutes", message: "Session timeout must be at least 5 minutes" })
  }
  return errors
}

// ---------------------------------------------------------------------------
// Finalize — backend orchestration (idempotent / resumable)
// ---------------------------------------------------------------------------

export class OnboardingValidationError extends Error {
  fieldErrors: FieldError[]
  status = 400
  constructor(fieldErrors: FieldError[]) {
    super("The onboarding is incomplete. Please resolve the highlighted fields.")
    this.name = "OnboardingValidationError"
    this.fieldErrors = fieldErrors
  }
}

export type FinalizeResult = {
  record: OnboardingRecord
  tenantId: number
  adminUserId: number
  /** Present only when a NEW admin user was created on this run. */
  adminTempPassword: string | null
}

/**
 * Turn a completed draft into a live tenant. Runs as a sequence of steps that
 * each persist their result, so a failure mid-way leaves the record in
 * `failed` with the already-created ids recorded — re-running finalize then
 * resumes from where it stopped instead of duplicating anything.
 */
export async function finalizeOnboarding(
  id: number,
  actor: { userId: number; email?: string | null },
): Promise<FinalizeResult> {
  await ensureOnboardingSchema()
  const record = await getOnboarding(id)
  if (!record) throw new OnboardingStateError("Onboarding session not found", 404)

  if (record.status === "completed" && record.createdTenantId && record.createdAdminUserId) {
    return {
      record,
      tenantId: record.createdTenantId,
      adminUserId: record.createdAdminUserId,
      adminTempPassword: null,
    }
  }

  const errors = validateOnboarding(record.data)
  if (errors.length > 0) {
    await query(`UPDATE \`tenant_onboarding\` SET \`error_message\` = ? WHERE \`id\` = ?`, [
      "Validation failed before provisioning",
      id,
    ])
    throw new OnboardingValidationError(errors)
  }

  const data = record.data
  let tenantId = record.createdTenantId
  let adminUserId = record.createdAdminUserId
  let adminTempPassword: string | null = null

  try {
    // --- Step 1: provision the tenant (skip if a prior run already made it) ---
    if (!tenantId) {
      const slug = data.slug!.toLowerCase().trim()
      const existing = await getTenantBySlug(slug)
      if (existing) {
        throw new OnboardingStateError(`A tenant with slug "${slug}" already exists`, 409)
      }
      const tenant = await createTenant({
        name: data.companyName!.trim(),
        slug,
        plan: data.plan,
        deployment_model: data.deploymentModel,
        settings: buildTenantSettings(data),
      })
      tenantId = tenant.id
      await query(`UPDATE \`tenant_onboarding\` SET \`created_tenant_id\` = ? WHERE \`id\` = ?`, [tenantId, id])
    }

    // --- Step 2: seed the first admin (tenant owner) user ---
    if (!adminUserId) {
      const email = data.adminEmail!.toLowerCase().trim()
      const dupe = await query<{ id: number }[]>(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email])
      if (dupe.length > 0) {
        throw new OnboardingStateError(
          `A user with email "${email}" already exists. Choose a different admin email.`,
          409,
        )
      }
      adminTempPassword = generateTempPassword(12)
      const passwordHash = await hashPassword(adminTempPassword)
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [res] = await conn.query<any>(
          `INSERT INTO users (tenant_id, name, email, password_hash, role, platform_role, tenant_role, designation, status, must_change_password)
           VALUES (?, ?, ?, ?, 'admin', 'none', 'tenant_owner', ?, 'active', 1)`,
          [tenantId, data.adminName!.trim(), email, passwordHash, "Organization Owner"],
        )
        adminUserId = Number(res.insertId)
        await conn.query(`UPDATE \`tenant_onboarding\` SET \`created_admin_user_id\` = ? WHERE \`id\` = ?`, [
          adminUserId,
          id,
        ])
        await conn.commit()
      } catch (e) {
        await conn.rollback()
        throw e
      } finally {
        conn.release()
      }
    }

    // --- Step 3: mark completed ---
    await query(
      `UPDATE \`tenant_onboarding\`
          SET \`status\` = 'completed', \`current_step\` = ?, \`error_message\` = NULL, \`completed_at\` = NOW()
        WHERE \`id\` = ?`,
      [ONBOARDING_STEPS.length - 1, id],
    )

    await recordPlatformAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action: "onboard_tenant",
      targetTenantId: tenantId,
      targetUserId: adminUserId,
      detail: { onboardingId: id, companyName: data.companyName, slug: data.slug, plan: data.plan },
    })

    const updated = (await getOnboarding(id))!
    return { record: updated, tenantId: tenantId!, adminUserId: adminUserId!, adminTempPassword }
  } catch (err: any) {
    // Persist the failure + any partial progress so finalize can be retried.
    await query(
      `UPDATE \`tenant_onboarding\`
          SET \`status\` = 'failed', \`error_message\` = ?
        WHERE \`id\` = ?`,
      [String(err?.message ?? "Onboarding failed").slice(0, 2000), id],
    )
    throw err
  }
}

/** Fold the non-provisioning config onto the tenant settings JSON. */
function buildTenantSettings(data: OnboardingData): Record<string, unknown> {
  return {
    profile: {
      legalEntity: data.legalEntity ?? null,
      industry: data.industry ?? null,
      companySize: data.companySize ?? null,
    },
    localization: {
      country: data.country ?? null,
      currency: data.currency ?? null,
      timezone: data.timezone ?? null,
      fiscalYearStart: data.fiscalYearStart ?? null,
      language: data.language ?? null,
    },
    tax: {
      taxId: data.taxId ?? null,
      taxScheme: data.taxScheme ?? null,
    },
    address: {
      line1: data.addressLine1 ?? null,
      line2: data.addressLine2 ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      postalCode: data.postalCode ?? null,
      country: data.addressCountry ?? data.country ?? null,
    },
    branding: {
      primaryColor: data.primaryColor ?? null,
      accentColor: data.accentColor ?? null,
      logoUrl: data.logoUrl ?? null,
    },
    domain: {
      customDomain: data.customDomain ?? null,
    },
    storage: {
      region: data.storageRegion ?? null,
      quotaGb: data.storageQuotaGb ?? null,
    },
    security: {
      requireMfa: data.requireMfa ?? false,
      passwordPolicy: data.passwordPolicy ?? "standard",
      sessionTimeoutMinutes: data.sessionTimeoutMinutes ?? null,
      ipAllowlist: data.ipAllowlist ?? null,
    },
    onboardedAt: new Date().toISOString(),
  }
}
