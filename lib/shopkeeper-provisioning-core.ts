/**
 * SPEC (Shopkeeper provisioning) — the PURE core.
 * ---------------------------------------------------------------------------
 * DB-free, framework-free logic for provisioning a Shopkeeper customer, so the
 * validation, normalization, password generation and plan-eligibility rules can
 * be unit-tested in isolation (mirrors lib/subscription-engine.ts and
 * lib/user-lifecycle-core.ts). The DB-touching orchestration lives in
 * lib/shopkeeper-provisioning.ts and drives everything through this module so
 * the service, the API and the tests can never disagree about what is valid.
 *
 * SECURITY: the tenant_type is NEVER taken from client input here — the service
 * always provisions a SHOPKEEPER tenant. Passwords are generated with
 * node:crypto (cryptographically secure), never Math.random, and this module
 * only ever handles the plaintext long enough to hash it downstream; it never
 * persists or logs it.
 */
import { randomInt } from "node:crypto"

// ---------------------------------------------------------------------------
// Field-level validation error (shared shape with the onboarding wizard).
// ---------------------------------------------------------------------------
export type ShopkeeperField =
  | "businessName"
  | "displayName"
  | "businessMobile"
  | "country"
  | "timezone"
  | "currency"
  | "ownerName"
  | "ownerEmail"
  | "ownerMobile"
  | "planCode"
  | "password"

export type ShopkeeperFieldError = { field: ShopkeeperField; message: string }

// ---------------------------------------------------------------------------
// Input / output shapes.
// ---------------------------------------------------------------------------

/** Raw, untrusted input as it arrives from the Add Shopkeeper form. */
export type RawShopkeeperInput = {
  businessName?: unknown
  displayName?: unknown
  businessMobile?: unknown
  country?: unknown
  timezone?: unknown
  currency?: unknown
  ownerName?: unknown
  ownerEmail?: unknown
  ownerMobile?: unknown
  planCode?: unknown
  /** When true the service generates a secure temporary password. */
  generatePassword?: unknown
  /** Operator-supplied password (used only when generatePassword is falsey). */
  password?: unknown
  /** Optional: start the subscription as a trial when the plan supports it. */
  startTrial?: unknown
}

/** Clean, validated values the service provisions from. */
export type NormalizedShopkeeperInput = {
  businessName: string
  displayName: string | null
  businessMobile: string | null
  country: string | null
  timezone: string | null
  currency: string
  ownerName: string
  ownerEmail: string
  ownerMobile: string | null
  planCode: string
  generatePassword: boolean
  password: string | null
  startTrial: boolean
}

export type NormalizeResult =
  | { ok: true; value: NormalizedShopkeeperInput }
  | { ok: false; errors: ShopkeeperFieldError[] }

// ---------------------------------------------------------------------------
// Primitive validators.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// E.164-ish: optional +, 7-20 digits, allowing spaces / hyphens / parens in raw.
const PHONE_RE = /^\+?[0-9]{7,20}$/
const CURRENCY_RE = /^[A-Z]{3}$/

export const DEFAULT_CURRENCY = "INR"

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function boolish(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === 1 || value === "1"
}

/** Strip formatting characters from a phone number before validation/storage. */
export function normalizePhone(value: unknown): string | null {
  const raw = str(value)
  if (!raw) return null
  const compact = raw.replace(/[\s()\-.]/g, "")
  return compact || null
}

/**
 * Password policy for Shopkeeper owner accounts: at least 8 characters with a
 * letter and a number. Matches the self-service signup policy so the same
 * credentials satisfy every authentication surface, including the mobile API.
 */
export function validatePasswordPolicy(password: string): string | null {
  if (!password || password.length < 8) return "Password must be at least 8 characters."
  if (!/[A-Za-z]/.test(password)) return "Password must include at least one letter."
  if (!/[0-9]/.test(password)) return "Password must include at least one number."
  return null
}

// ---------------------------------------------------------------------------
// Cryptographically secure temporary password generation.
// ---------------------------------------------------------------------------

// Ambiguity-free alphabet (no 0/O, 1/l/I) split by class so we can guarantee
// the generated password satisfies the policy above.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
const LOWER = "abcdefghijkmnopqrstuvwxyz"
const DIGITS = "23456789"
const SYMBOLS = "!@#$%*?"
const ALL = UPPER + LOWER + DIGITS + SYMBOLS

function pick(alphabet: string): string {
  return alphabet[randomInt(0, alphabet.length)]
}

/**
 * Generate a cryptographically secure temporary password that always satisfies
 * `validatePasswordPolicy`. Uses node:crypto's `randomInt` (CSPRNG), never
 * Math.random. The result is shown to the operator once and then discarded — it
 * is only ever hashed for storage.
 */
export function generateSecurePassword(length = 14): string {
  const len = Math.max(12, Math.min(64, Math.floor(length)))
  const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(DIGITS), pick(SYMBOLS)]
  const rest: string[] = []
  for (let i = required.length; i < len; i++) rest.push(pick(ALL))
  const chars = [...required, ...rest]
  // Fisher–Yates shuffle with CSPRNG indices so required classes are not
  // clustered at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join("")
}

// ---------------------------------------------------------------------------
// Slug generation (shared logic with tenant self-service signup).
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/

/** Turn a business name into a candidate tenant slug. */
export function slugifyBusinessName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 90)
  if (base.length >= 2 && SLUG_RE.test(base)) return base
  return `shop-${base}`.replace(/-+$/g, "").slice(0, 90) || "shop"
}

// ---------------------------------------------------------------------------
// Plan eligibility.
// ---------------------------------------------------------------------------

export type PlanLike = { code: string; features?: string[]; is_active?: boolean }

/**
 * A plan is a Shopkeeper plan when its code is one of the known shopkeeper
 * codes OR it advertises the shopkeeper app feature. Keeps the dedicated
 * provisioning endpoint from ever attaching a Shopkeeper to an ERP plan.
 */
export function isShopkeeperPlan(plan: PlanLike): boolean {
  const code = (plan.code || "").toLowerCase()
  if (code === "shopkeeper" || code === "shopkeeper-trial" || code.startsWith("shopkeeper")) return true
  const features = (plan.features ?? []).map((f) => String(f).toLowerCase())
  return features.includes("shopkeeper_app")
}

/** True when a plan is a trial-style Shopkeeper plan. */
export function isTrialPlan(plan: PlanLike): boolean {
  const code = (plan.code || "").toLowerCase()
  if (code.includes("trial")) return true
  return (plan.features ?? []).map((f) => String(f).toLowerCase()).includes("trial")
}

// ---------------------------------------------------------------------------
// Normalization + validation.
// ---------------------------------------------------------------------------

/**
 * Validate and normalize the Add Shopkeeper form body. Returns a discriminated
 * result: either the clean values to provision from, or the list of field
 * errors the UI highlights. This is the authoritative server-side validation
 *; client validation is UX only.
 */
export function normalizeShopkeeperInput(raw: RawShopkeeperInput): NormalizeResult {
  const errors: ShopkeeperFieldError[] = []

  const businessName = str(raw.businessName)
  if (businessName.length < 2) errors.push({ field: "businessName", message: "Business name is required" })
  if (businessName.length > 150) errors.push({ field: "businessName", message: "Business name is too long" })

  const displayNameRaw = str(raw.displayName)
  const displayName = displayNameRaw ? displayNameRaw.slice(0, 150) : null

  const businessMobile = normalizePhone(raw.businessMobile)
  if (businessMobile && !PHONE_RE.test(businessMobile)) {
    errors.push({ field: "businessMobile", message: "Enter a valid business mobile number" })
  }

  const country = str(raw.country) ? str(raw.country).slice(0, 120) : null

  const timezone = str(raw.timezone) ? str(raw.timezone).slice(0, 80) : null

  const currencyRaw = str(raw.currency).toUpperCase()
  const currency = currencyRaw || DEFAULT_CURRENCY
  if (!CURRENCY_RE.test(currency)) {
    errors.push({ field: "currency", message: "Currency must be a 3-letter code (e.g. INR, USD)" })
  }

  const ownerName = str(raw.ownerName)
  if (ownerName.length < 2) errors.push({ field: "ownerName", message: "Owner name is required" })
  if (ownerName.length > 150) errors.push({ field: "ownerName", message: "Owner name is too long" })

  const ownerEmail = str(raw.ownerEmail).toLowerCase()
  if (!EMAIL_RE.test(ownerEmail)) errors.push({ field: "ownerEmail", message: "A valid owner email is required" })

  const ownerMobile = normalizePhone(raw.ownerMobile)
  if (ownerMobile && !PHONE_RE.test(ownerMobile)) {
    errors.push({ field: "ownerMobile", message: "Enter a valid owner mobile number" })
  }

  const planCode = str(raw.planCode).toLowerCase()
  if (!planCode) errors.push({ field: "planCode", message: "Select a subscription plan" })

  const generatePassword = boolish(raw.generatePassword)
  let password: string | null = null
  if (!generatePassword) {
    const provided = typeof raw.password === "string" ? raw.password : ""
    const pwError = validatePasswordPolicy(provided)
    if (pwError) errors.push({ field: "password", message: pwError })
    else password = provided
  }

  const startTrial = boolish(raw.startTrial)

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      businessName,
      displayName,
      businessMobile,
      country,
      timezone,
      currency,
      ownerName,
      ownerEmail,
      ownerMobile,
      planCode,
      generatePassword,
      password,
      startTrial,
    },
  }
}
