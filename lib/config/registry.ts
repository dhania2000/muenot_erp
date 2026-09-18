/**
 * SPEC 37 — Environment / Configuration management.
 * ---------------------------------------------------------------------------
 * Phase 1 (inventory) codified as data. This registry is the single, reviewed
 * catalogue of every configuration value the platform understands. Nothing here
 * is a secret VALUE — these are only DESCRIPTORS: what a key means, which axis
 * owns it (platform vs tenant), which category it belongs to, whether it holds
 * a secret, which process.env variable (if any) overrides it, and the last
 * resort default.
 *
 * Keeping this pure (no `server-only`, no DB, no process.env) means the
 * precedence + secret-exposure rules built on top of it can be unit-tested
 * directly (Phase 4) without a database or a running server.
 *
 * Descriptor `key`s intentionally match the underlying store key so the service
 * layer can resolve them with a trivial lookup:
 *   - platform-scoped keys mirror `platform_config.config_key`
 *     (and `flag.<flag_key>` for platform feature flags)
 *   - env-backed keys use the exact process.env variable name
 *   - tenant-scoped keys mirror the tenant settings key
 */

export const CONFIG_CATEGORIES = [
  "application",
  "feature_flags",
  "integration",
  "email",
  "storage",
  "jobs",
  "api",
  "security",
] as const

export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<ConfigCategory, string> = {
  application: "Application settings",
  feature_flags: "Feature flags",
  integration: "Integration configuration",
  email: "Email configuration",
  storage: "Storage configuration",
  jobs: "Job configuration",
  api: "API settings",
  security: "Security settings",
}

/**
 * The ownership axis. This is the platform/tenant separation SPEC 37 requires:
 * a platform-scoped value describes the business of running Muenot itself and is
 * resolved from platform stores + deployment env only; a tenant-scoped value is
 * per-workspace and is resolved from that tenant's own settings.
 */
export type ConfigScope = "platform" | "tenant"

export type ConfigDescriptor = {
  key: string
  label: string
  description: string
  category: ConfigCategory
  scope: ConfigScope
  /** A secret VALUE is never serialized off the server — only its presence. */
  secret: boolean
  /** process.env variable that, when set, takes precedence over stored values. */
  envVar?: string
  /** Last-resort default when neither env nor a store provides a value. */
  default?: string
}

/**
 * The catalogue. Grouped by category for readability; order within a category
 * is preserved in the overview UI.
 */
export const CONFIG_REGISTRY: ConfigDescriptor[] = [
  // --- Application settings -------------------------------------------------
  {
    key: "platform.name",
    label: "Platform name",
    description: "Display name of the platform shown to tenants.",
    category: "application",
    scope: "platform",
    secret: false,
    default: "Muenot",
  },
  {
    key: "platform.support_email",
    label: "Support email",
    description: "Support contact surfaced to tenants.",
    category: "application",
    scope: "platform",
    secret: false,
    default: "support@muenot.com",
  },
  {
    key: "APP_URL",
    label: "Application base URL",
    description: "Canonical base URL used to build absolute links in emails and callbacks.",
    category: "application",
    scope: "platform",
    secret: false,
    envVar: "APP_URL",
    default: "http://localhost:3000",
  },
  {
    key: "tenants.default_plan",
    label: "Default tenant plan",
    description: "Plan assigned to newly created tenants.",
    category: "application",
    scope: "platform",
    secret: false,
    default: "starter",
  },
  {
    key: "billing.currency",
    label: "Default billing currency",
    description: "Currency used for platform billing.",
    category: "application",
    scope: "platform",
    secret: false,
    default: "USD",
  },
  {
    key: "app.currency",
    label: "Workspace currency",
    description: "Default currency code for a tenant workspace.",
    category: "application",
    scope: "tenant",
    secret: false,
    default: "INR",
  },
  {
    key: "theme.mode",
    label: "Workspace theme",
    description: "Default theme mode for a tenant workspace.",
    category: "application",
    scope: "tenant",
    secret: false,
    default: "dark",
  },
  {
    key: "DB_HOST",
    label: "Database host",
    description: "MySQL host the application connects to.",
    category: "application",
    scope: "platform",
    secret: false,
    envVar: "DB_HOST",
  },
  {
    key: "DB_NAME",
    label: "Database name",
    description: "MySQL schema name.",
    category: "application",
    scope: "platform",
    secret: false,
    envVar: "DB_NAME",
  },
  {
    key: "DB_PASSWORD",
    label: "Database password",
    description: "MySQL password. Deployment secret.",
    category: "application",
    scope: "platform",
    secret: true,
    envVar: "DB_PASSWORD",
  },

  // --- Feature flags (platform, per-flag rollout) ---------------------------
  {
    key: "flag.new_billing_ui",
    label: "New billing UI",
    description: "Roll out the redesigned billing screens.",
    category: "feature_flags",
    scope: "platform",
    secret: false,
    default: "disabled",
  },
  {
    key: "flag.ai_assistant",
    label: "AI assistant",
    description: "In-app AI assistant across modules.",
    category: "feature_flags",
    scope: "platform",
    secret: false,
    default: "disabled",
  },
  {
    key: "flag.advanced_reports",
    label: "Advanced reports",
    description: "Extended finance & analytics reporting.",
    category: "feature_flags",
    scope: "platform",
    secret: false,
    default: "enabled",
  },
  {
    key: "flag.self_serve_signup",
    label: "Self-serve signup",
    description: "Allow tenants to sign up without an operator.",
    category: "feature_flags",
    scope: "platform",
    secret: false,
    default: "disabled",
  },

  // --- Integration configuration --------------------------------------------
  {
    key: "TWILIO_ACCOUNT_SID",
    label: "Twilio account SID",
    description: "Twilio account identifier for voice/SMS.",
    category: "integration",
    scope: "platform",
    secret: true,
    envVar: "TWILIO_ACCOUNT_SID",
  },
  {
    key: "TWILIO_AUTH_TOKEN",
    label: "Twilio auth token",
    description: "Twilio authentication token.",
    category: "integration",
    scope: "platform",
    secret: true,
    envVar: "TWILIO_AUTH_TOKEN",
  },
  {
    key: "WHATSAPP_ACCESS_TOKEN",
    label: "WhatsApp access token",
    description: "Meta Graph API access token for WhatsApp.",
    category: "integration",
    scope: "platform",
    secret: true,
    envVar: "WHATSAPP_ACCESS_TOKEN",
  },
  {
    key: "WHATSAPP_PHONE_NUMBER_ID",
    label: "WhatsApp phone number ID",
    description: "WhatsApp Business phone number identifier.",
    category: "integration",
    scope: "platform",
    secret: false,
    envVar: "WHATSAPP_PHONE_NUMBER_ID",
  },
  {
    key: "GOOGLE_CLIENT_ID",
    label: "Google client ID",
    description: "OAuth client ID for Google integrations.",
    category: "integration",
    scope: "platform",
    secret: false,
    envVar: "GOOGLE_CLIENT_ID",
  },
  {
    key: "GOOGLE_CLIENT_SECRET",
    label: "Google client secret",
    description: "OAuth client secret for Google integrations.",
    category: "integration",
    scope: "platform",
    secret: true,
    envVar: "GOOGLE_CLIENT_SECRET",
  },
  {
    key: "GSTIN_API_KEY",
    label: "GSTIN API key",
    description: "API key for GSTIN verification.",
    category: "integration",
    scope: "platform",
    secret: true,
    envVar: "GSTIN_API_KEY",
  },

  // --- Email configuration ---------------------------------------------------
  {
    key: "SMTP_HOST",
    label: "SMTP host",
    description: "Outbound mail server hostname.",
    category: "email",
    scope: "platform",
    secret: false,
    envVar: "SMTP_HOST",
  },
  {
    key: "SMTP_PORT",
    label: "SMTP port",
    description: "Outbound mail server port.",
    category: "email",
    scope: "platform",
    secret: false,
    envVar: "SMTP_PORT",
    default: "587",
  },
  {
    key: "SMTP_USER",
    label: "SMTP username",
    description: "Authentication username for the mail server.",
    category: "email",
    scope: "platform",
    secret: false,
    envVar: "SMTP_USER",
  },
  {
    key: "SMTP_PASS",
    label: "SMTP password",
    description: "Authentication password for the mail server.",
    category: "email",
    scope: "platform",
    secret: true,
    envVar: "SMTP_PASS",
  },
  {
    key: "SMTP_FROM",
    label: "Default from address",
    description: "Default sender address for outbound email.",
    category: "email",
    scope: "platform",
    secret: false,
    envVar: "SMTP_FROM",
  },
  {
    key: "notifications.email_enabled",
    label: "Email notifications",
    description: "Whether a tenant sends application email notifications.",
    category: "email",
    scope: "tenant",
    secret: false,
    default: "true",
  },

  // --- Storage configuration -------------------------------------------------
  {
    key: "storage.provider",
    label: "Storage provider",
    description: "Storage backend used by tenant uploads.",
    category: "storage",
    scope: "tenant",
    secret: false,
    default: "Vercel Blob",
  },
  {
    key: "BLOB_READ_WRITE_TOKEN",
    label: "Blob read/write token",
    description: "Access token for Vercel Blob storage.",
    category: "storage",
    scope: "platform",
    secret: true,
    envVar: "BLOB_READ_WRITE_TOKEN",
  },
  {
    key: "STORAGE_URL_SIGNING_SECRET",
    label: "Storage URL signing secret",
    description: "Secret used to sign time-limited download URLs.",
    category: "storage",
    scope: "platform",
    secret: true,
    envVar: "STORAGE_URL_SIGNING_SECRET",
  },
  {
    key: "LIBRARY_STORAGE_QUOTA_BYTES",
    label: "Library storage quota",
    description: "Per-workspace library storage quota in bytes.",
    category: "storage",
    scope: "platform",
    secret: false,
    envVar: "LIBRARY_STORAGE_QUOTA_BYTES",
  },

  // --- Job configuration -----------------------------------------------------
  {
    key: "CRON_SECRET",
    label: "Cron secret",
    description: "Shared secret authenticating scheduled cron invocations.",
    category: "jobs",
    scope: "platform",
    secret: true,
    envVar: "CRON_SECRET",
  },

  // --- API settings ----------------------------------------------------------
  {
    key: "api.rest_enabled",
    label: "REST API enabled",
    description: "Whether a tenant may access the REST API.",
    category: "api",
    scope: "tenant",
    secret: false,
    default: "false",
  },
  {
    key: "NEXT_PUBLIC_APP_URL",
    label: "Public app URL",
    description: "Client-visible base URL used by API callbacks and links.",
    category: "api",
    scope: "platform",
    secret: false,
    envVar: "NEXT_PUBLIC_APP_URL",
  },

  // --- Security settings -----------------------------------------------------
  {
    key: "SESSION_SECRET",
    label: "Session signing secret",
    description: "Secret used to sign and verify session tokens.",
    category: "security",
    scope: "platform",
    secret: true,
    envVar: "SESSION_SECRET",
  },
  {
    key: "SETTINGS_ENCRYPTION_KEY",
    label: "Settings encryption key",
    description: "Key used to encrypt stored secrets at rest.",
    category: "security",
    scope: "platform",
    secret: true,
    envVar: "SETTINGS_ENCRYPTION_KEY",
  },
  {
    key: "TENANT_ISOLATION_MODE",
    label: "Tenant isolation mode",
    description: "Query-guard enforcement mode: report or enforce.",
    category: "security",
    scope: "platform",
    secret: false,
    envVar: "TENANT_ISOLATION_MODE",
    default: "report",
  },
  {
    key: "security.session_ttl_hours",
    label: "Session lifetime (hours)",
    description: "Platform session lifetime before re-authentication.",
    category: "security",
    scope: "platform",
    secret: false,
    default: "12",
  },
  {
    key: "security.max_login_attempts",
    label: "Max login attempts",
    description: "Failed logins before lockout.",
    category: "security",
    scope: "platform",
    secret: false,
    default: "5",
  },
  {
    key: "security.session_timeout",
    label: "Workspace session timeout (min)",
    description: "Tenant session timeout in minutes.",
    category: "security",
    scope: "tenant",
    secret: false,
    default: "480",
  },
]

const BY_KEY = new Map(CONFIG_REGISTRY.map((d) => [d.key, d]))

export function getDescriptor(key: string): ConfigDescriptor | undefined {
  return BY_KEY.get(key)
}

export function descriptorsByCategory(category: ConfigCategory): ConfigDescriptor[] {
  return CONFIG_REGISTRY.filter((d) => d.category === category)
}
