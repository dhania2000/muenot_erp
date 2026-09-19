import "server-only"
import { pool, query } from "@/lib/db"
import { hashPassword } from "@/lib/password"
import { ensureTenantSchema, getTenantBySlug } from "@/lib/tenant-service"
import { ensureUserLifecycleSchema } from "@/lib/user-lifecycle"

/**
 * Self-service Business/Organization signup.
 *
 * Creates a brand-new tenant together with its owner/admin user in a single
 * database transaction, so a half-created tenant (a tenant with no owner, or a
 * user with no tenant) can never exist. The tenant is always created BEFORE the
 * session is issued and before WhatsApp Embedded Signup runs, so the Meta
 * connection is guaranteed to attach to the correct, already-persisted tenant.
 *
 * SECURITY: nothing here trusts a client-supplied tenant id. The tenant is
 * created server-side and its id is what the caller bakes into the session.
 */

export class RegistrationError extends Error {
  status: number
  field?: string
  constructor(message: string, status = 400, field?: string) {
    super(message)
    this.name = "RegistrationError"
    this.status = status
    this.field = field
  }
}

export type OnboardingState = "setup_pending" | "whatsapp_pending" | "active" | "suspended"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/

// ---------------------------------------------------------------------------
// Self-healing schema additions for signup
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

async function runEnsure(): Promise<void> {
  await ensureTenantSchema()
  await ensureUserLifecycleSchema()

  // Onboarding lifecycle for a tenant. Defaults to 'active' so every EXISTING
  // tenant (created before this column) keeps working unchanged; only tenants
  // born through self-service signup start in 'whatsapp_pending'.
  if (!(await columnExists("tenants", "onboarding_state"))) {
    await query(
      "ALTER TABLE `tenants` ADD COLUMN `onboarding_state` ENUM('setup_pending','whatsapp_pending','active','suspended') NOT NULL DEFAULT 'active' AFTER `status`",
    )
  }

  // A contact mobile number for the owner captured at signup. Additive/nullable
  // so it never disturbs existing rows.
  if (!(await columnExists("users", "mobile"))) {
    await query("ALTER TABLE `users` ADD COLUMN `mobile` VARCHAR(40) DEFAULT NULL AFTER `email`")
  }
}

/** Ensure the signup-specific schema exists. Cached per process. */
export async function ensureSignupSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Password policy shared with signup UI copy: >= 8 chars, a letter and a number. */
export function validatePassword(password: string): string | null {
  if (!password || password.length < 8) return "Password must be at least 8 characters."
  if (!/[A-Za-z]/.test(password)) return "Password must include at least one letter."
  if (!/[0-9]/.test(password)) return "Password must include at least one number."
  return null
}

/** Turn a company name into a candidate slug. */
function slugifyBase(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 90)
  if (base.length >= 2 && SLUG_RE.test(base)) return base
  // Fall back to a stable prefix when the name has no usable ASCII characters.
  return `tenant-${base}`.replace(/-+$/g, "").slice(0, 90) || "tenant"
}

/** Find a slug derived from the company name that is not already taken. */
async function generateUniqueSlug(companyName: string): Promise<string> {
  const base = slugifyBase(companyName)
  let candidate = base
  let n = 1
  // Bounded loop; collisions are rare and each check is a single indexed lookup.
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export type RegisterBusinessInput = {
  companyName: string
  adminName: string
  email: string
  mobile?: string | null
  password: string
}

export type RegisterBusinessResult = {
  tenantId: number
  tenantSlug: string
  userId: number
  name: string
  email: string
  role: "admin"
}

/**
 * Create a new tenant and its owner/admin user atomically. Rejects duplicate
 * emails and duplicate company names with a 409 so the UI can surface a clear
 * "already exists" message.
 */
export async function registerBusiness(input: RegisterBusinessInput): Promise<RegisterBusinessResult> {
  await ensureSignupSchema()

  const companyName = (input.companyName ?? "").trim()
  const adminName = (input.adminName ?? "").trim()
  const email = (input.email ?? "").toLowerCase().trim()
  const mobile = (input.mobile ?? "").trim() || null
  const password = input.password ?? ""

  if (companyName.length < 2) throw new RegistrationError("Company name is required.", 400, "companyName")
  if (adminName.length < 2) throw new RegistrationError("Your name is required.", 400, "adminName")
  if (!EMAIL_RE.test(email)) throw new RegistrationError("A valid work email is required.", 400, "email")
  const pwError = validatePassword(password)
  if (pwError) throw new RegistrationError(pwError, 400, "password")

  // Duplicate email across ALL tenants — email is globally unique on users.
  const existingUser = await query<any[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [email])
  if (existingUser[0]) {
    throw new RegistrationError("An account with this email already exists. Try signing in instead.", 409, "email")
  }

  // Duplicate company name (case-insensitive) — a friendlier guard than only the
  // slug uniqueness, since two companies with the same display name is confusing.
  const existingTenant = await query<any[]>(
    "SELECT id FROM tenants WHERE LOWER(name) = ? LIMIT 1",
    [companyName.toLowerCase()],
  )
  if (existingTenant[0]) {
    throw new RegistrationError("A company with this name is already registered.", 409, "companyName")
  }

  const slug = await generateUniqueSlug(companyName)
  const passwordHash = await hashPassword(password)

  const conn = await pool.getConnection()
  let tenantId: number
  let userId: number
  try {
    await conn.beginTransaction()

    const [tenantRes] = await conn.query<any>(
      `INSERT INTO tenants
         (name, slug, status, onboarding_state, deployment_model, plan, is_platform_owner)
       VALUES (?, ?, 'active', 'whatsapp_pending', 'shared_database', 'standard', 0)`,
      [companyName, slug],
    )
    tenantId = Number(tenantRes.insertId)

    const [userRes] = await conn.query<any>(
      `INSERT INTO users
         (tenant_id, name, email, mobile, password_hash, role, tenant_role, platform_role,
          status, lifecycle_state, must_change_password, activated_at)
       VALUES (?, ?, ?, ?, ?, 'admin', 'tenant_owner', 'none', 'active', 'active', 0, NOW())`,
      [tenantId, adminName, email, mobile, passwordHash],
    )
    userId = Number(userRes.insertId)

    await conn.commit()
  } catch (e) {
    await conn.rollback()
    // A race on the unique slug/email indexes surfaces here — report as a conflict.
    const code = (e as { code?: string })?.code
    if (code === "ER_DUP_ENTRY") {
      throw new RegistrationError("That company or email was just registered. Please try again.", 409)
    }
    throw e
  } finally {
    conn.release()
  }

  return { tenantId, tenantSlug: slug, userId, name: adminName, email, role: "admin" }
}

// ---------------------------------------------------------------------------
// Onboarding state
// ---------------------------------------------------------------------------

const ONBOARDING_STATES: OnboardingState[] = ["setup_pending", "whatsapp_pending", "active", "suspended"]

/** Read a tenant's onboarding state. Returns null when the tenant is unknown. */
export async function getTenantOnboardingState(tenantId: number): Promise<OnboardingState | null> {
  await ensureSignupSchema()
  const rows = await query<{ onboarding_state: OnboardingState }[]>(
    "SELECT `onboarding_state` FROM `tenants` WHERE `id` = ? LIMIT 1",
    [tenantId],
  )
  return rows[0]?.onboarding_state ?? null
}

/**
 * Advance a tenant's onboarding state. Always called with a tenant id resolved
 * from the authenticated session — never from client input.
 */
export async function setTenantOnboardingState(tenantId: number, state: OnboardingState): Promise<void> {
  await ensureSignupSchema()
  if (!ONBOARDING_STATES.includes(state)) throw new RegistrationError(`Invalid onboarding state "${state}"`, 400)
  await query("UPDATE `tenants` SET `onboarding_state` = ? WHERE `id` = ?", [state, tenantId])
}
