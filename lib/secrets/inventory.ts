/**
 * Secret management. PHASE 1: INVENTORY.
 * ---------------------------------------------------------------------------
 * The single, reviewed catalogue of every SECRET the platform holds. This is
 * pure data — descriptors, never values — so the masking, rotation and audit
 * rules built on top of it (lib/secrets/model.ts) are unit-testable without a
 * database, a running server, or `server-only` (Phase 4).
 *
 * A secret is deliberately narrower than a config value: only the
 * classes the spec enumerates live here —
 *   API keys · OAuth secrets · Storage credentials · SMTP credentials ·
 *   Payment secrets · Webhook secrets · Encryption keys.
 *
 * Each descriptor's `key` is the canonical secret identifier and mirrors the
 * deployment `envVar` binding, so the store can resolve a stored value against
 * the deployment boundary with a trivial lookup (env overrides stored, exactly
 * like the config service).
 */

export const SECRET_CATEGORIES = [
  "api_key",
  "oauth_secret",
  "storage_credential",
  "smtp_credential",
  "payment_secret",
  "webhook_secret",
  "encryption_key",
] as const

export type SecretCategory = (typeof SECRET_CATEGORIES)[number]

export const SECRET_CATEGORY_LABELS: Record<SecretCategory, string> = {
  api_key: "API keys",
  oauth_secret: "OAuth secrets",
  storage_credential: "Storage credentials",
  smtp_credential: "SMTP credentials",
  payment_secret: "Payment secrets",
  webhook_secret: "Webhook secrets",
  encryption_key: "Encryption keys",
}

export type SecretDescriptor = {
  /** Canonical secret identifier; mirrors the deployment env variable. */
  key: string
  label: string
  description: string
  category: SecretCategory
  /** Deployment env variable that, when set, takes precedence over a stored value. */
  envVar: string
  /** Recommended rotation cadence in days. Drives the rotation-due status. */
  rotationIntervalDays: number
  /** A critical secret compromises the whole platform if leaked. */
  critical: boolean
}

/**
 * The catalogue. Grouped by category for readability; every entry maps to a
 * real secret this codebase consumes (verified against process.env usage).
 */
export const SECRET_INVENTORY: SecretDescriptor[] = [
  // --- Encryption keys -------------------------------------------------------
  {
    key: "SETTINGS_ENCRYPTION_KEY",
    label: "Settings encryption key",
    description: "Master key that encrypts every other stored secret at rest.",
    category: "encryption_key",
    envVar: "SETTINGS_ENCRYPTION_KEY",
    rotationIntervalDays: 180,
    critical: true,
  },
  {
    key: "SESSION_SECRET",
    label: "Session signing secret",
    description: "Signs and verifies session tokens.",
    category: "encryption_key",
    envVar: "SESSION_SECRET",
    rotationIntervalDays: 90,
    critical: true,
  },
  {
    key: "AUTH_SECRET",
    label: "Auth secret",
    description: "Signs authentication artifacts (password reset, invites).",
    category: "encryption_key",
    envVar: "AUTH_SECRET",
    rotationIntervalDays: 90,
    critical: true,
  },
  {
    key: "JWT_SECRET",
    label: "JWT secret",
    description: "Signs and verifies issued JSON Web Tokens.",
    category: "encryption_key",
    envVar: "JWT_SECRET",
    rotationIntervalDays: 90,
    critical: true,
  },

  // --- API keys --------------------------------------------------------------
  {
    key: "GSTIN_API_KEY",
    label: "GSTIN API key",
    description: "Key for the GSTIN verification service.",
    category: "api_key",
    envVar: "GSTIN_API_KEY",
    rotationIntervalDays: 180,
    critical: false,
  },
  {
    key: "TWILIO_AUTH_TOKEN",
    label: "Twilio auth token",
    description: "Primary authentication token for the Twilio account.",
    category: "api_key",
    envVar: "TWILIO_AUTH_TOKEN",
    rotationIntervalDays: 180,
    critical: true,
  },
  {
    key: "TWILIO_API_SECRET",
    label: "Twilio API secret",
    description: "Secret half of a scoped Twilio API key pair.",
    category: "api_key",
    envVar: "TWILIO_API_SECRET",
    rotationIntervalDays: 180,
    critical: false,
  },
  {
    key: "WHATSAPP_ACCESS_TOKEN",
    label: "WhatsApp access token",
    description: "Meta Graph API access token for WhatsApp Business.",
    category: "api_key",
    envVar: "WHATSAPP_ACCESS_TOKEN",
    rotationIntervalDays: 60,
    critical: true,
  },

  // --- OAuth secrets ---------------------------------------------------------
  {
    key: "GOOGLE_CLIENT_SECRET",
    label: "Google client secret",
    description: "OAuth client secret for Google integrations.",
    category: "oauth_secret",
    envVar: "GOOGLE_CLIENT_SECRET",
    rotationIntervalDays: 365,
    critical: true,
  },
  {
    key: "GOOGLE_REFRESH_TOKEN",
    label: "Google refresh token",
    description: "Long-lived OAuth refresh token for Google Calendar / Gmail.",
    category: "oauth_secret",
    envVar: "GOOGLE_REFRESH_TOKEN",
    rotationIntervalDays: 180,
    critical: true,
  },
  {
    key: "GMAIL_PRIVATE_KEY",
    label: "Gmail service-account key",
    description: "Service-account private key used to send mail via Gmail.",
    category: "oauth_secret",
    envVar: "GMAIL_PRIVATE_KEY",
    rotationIntervalDays: 180,
    critical: true,
  },
  {
    key: "FACEBOOK_APP_SECRET",
    label: "Facebook app secret",
    description: "OAuth app secret for Facebook / Meta login and publishing.",
    category: "oauth_secret",
    envVar: "FACEBOOK_APP_SECRET",
    rotationIntervalDays: 365,
    critical: false,
  },
  {
    key: "META_APP_SECRET",
    label: "Meta app secret",
    description: "OAuth app secret for the Meta Graph platform.",
    category: "oauth_secret",
    envVar: "META_APP_SECRET",
    rotationIntervalDays: 365,
    critical: false,
  },
  {
    key: "WHATSAPP_APP_SECRET",
    label: "WhatsApp app secret",
    description: "OAuth app secret for the WhatsApp Business app.",
    category: "oauth_secret",
    envVar: "WHATSAPP_APP_SECRET",
    rotationIntervalDays: 365,
    critical: false,
  },

  // --- Storage credentials ---------------------------------------------------
  {
    key: "BLOB_READ_WRITE_TOKEN",
    label: "Blob read/write token",
    description: "Access token for Vercel Blob storage.",
    category: "storage_credential",
    envVar: "BLOB_READ_WRITE_TOKEN",
    rotationIntervalDays: 180,
    critical: true,
  },
  {
    key: "STORAGE_URL_SIGNING_SECRET",
    label: "Storage URL signing secret",
    description: "Signs time-limited download URLs for stored files.",
    category: "storage_credential",
    envVar: "STORAGE_URL_SIGNING_SECRET",
    rotationIntervalDays: 90,
    critical: true,
  },
  {
    key: "DB_PASSWORD",
    label: "Database password",
    description: "Password for the application's MySQL connection.",
    category: "storage_credential",
    envVar: "DB_PASSWORD",
    rotationIntervalDays: 180,
    critical: true,
  },

  // --- SMTP credentials ------------------------------------------------------
  {
    key: "SMTP_PASS",
    label: "SMTP password",
    description: "Authentication password for the outbound mail server.",
    category: "smtp_credential",
    envVar: "SMTP_PASS",
    rotationIntervalDays: 180,
    critical: false,
  },

  // --- Payment secrets -------------------------------------------------------
  {
    key: "STRIPE_SECRET_KEY",
    label: "Stripe secret key",
    description: "Server-side Stripe API key used to create charges.",
    category: "payment_secret",
    envVar: "STRIPE_SECRET_KEY",
    rotationIntervalDays: 180,
    critical: true,
  },
  {
    key: "RAZORPAY_KEY_SECRET",
    label: "Razorpay key secret",
    description: "Server-side Razorpay key secret used to create orders.",
    category: "payment_secret",
    envVar: "RAZORPAY_KEY_SECRET",
    rotationIntervalDays: 180,
    critical: true,
  },

  // --- Webhook secrets -------------------------------------------------------
  {
    key: "STRIPE_WEBHOOK_SECRET",
    label: "Stripe webhook secret",
    description: "Verifies the signature of inbound Stripe webhooks.",
    category: "webhook_secret",
    envVar: "STRIPE_WEBHOOK_SECRET",
    rotationIntervalDays: 180,
    critical: false,
  },
  {
    key: "RAZORPAY_WEBHOOK_SECRET",
    label: "Razorpay webhook secret",
    description: "Verifies the signature of inbound Razorpay webhooks.",
    category: "webhook_secret",
    envVar: "RAZORPAY_WEBHOOK_SECRET",
    rotationIntervalDays: 180,
    critical: false,
  },
  {
    key: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    label: "WhatsApp webhook verify token",
    description: "Shared token verifying inbound WhatsApp webhook subscriptions.",
    category: "webhook_secret",
    envVar: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    rotationIntervalDays: 180,
    critical: false,
  },
  {
    key: "CRON_SECRET",
    label: "Cron secret",
    description: "Shared secret authenticating inbound scheduled cron calls.",
    category: "webhook_secret",
    envVar: "CRON_SECRET",
    rotationIntervalDays: 180,
    critical: true,
  },
]

const BY_KEY = new Map(SECRET_INVENTORY.map((d) => [d.key, d]))

export function getSecretDescriptor(key: string): SecretDescriptor | undefined {
  return BY_KEY.get(key)
}

export function isKnownSecret(key: string): boolean {
  return BY_KEY.has(key)
}

export function secretsByCategory(category: SecretCategory): SecretDescriptor[] {
  return SECRET_INVENTORY.filter((d) => d.category === category)
}
