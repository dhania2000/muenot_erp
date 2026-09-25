/**
 * Tenant integration secrets — PURE model.
 * ---------------------------------------------------------------------------
 * Spec 9 scopes each tenant's OWN integration credentials (Stripe keys, SMTP
 * password, Twilio token, a generic webhook secret, …) SEPARATELY from the
 * platform secrets in lib/secrets/inventory.ts. Platform secrets are operated
 * by platform super-admins; these belong to a single customer tenant, are
 * governed by tenant roles, and must never be visible across tenants.
 *
 * This module is the pure, DB-free, network-free core:
 *   • the integration CATALOGUE (which integrations exist + their fields);
 *   • validation of integration/field keys and vault choices;
 *   • the masked PUBLIC projection + a fail-closed no-exposure invariant;
 *   • rotation status and the ROLLBACK target selection over a version list;
 *   • a deterministic idempotency-key derivation for write actions.
 *
 * The store (lib/secrets/tenant-integration-store.ts) and the API routes build
 * on these; the vault provider abstraction (lib/secrets/providers) decides
 * WHERE a value is physically stored.
 */
import {
  SECRET_EMPTY,
  SECRET_MASK,
  type RotationStatus,
  daysBetween,
  maskSecret,
  rotationStatus,
} from "@/lib/secrets/model"
import { type HealthState, type VaultKind, VAULT_KIND_LABELS, isVaultKind } from "@/lib/secrets/providers/types"

export type IntegrationCategory = "payments" | "messaging" | "email" | "storage" | "webhook" | "custom"

/** One credential field within an integration (an integration can hold several). */
export type IntegrationField = {
  key: string
  label: string
  /** Optional per-field hint for the UI; never contains a value. */
  hint?: string
}

export type IntegrationDescriptor = {
  key: string
  label: string
  category: IntegrationCategory
  description: string
  fields: readonly IntegrationField[]
  /** Default rotation interval (days) for this integration's fields. */
  rotationIntervalDays: number
}

/**
 * The catalogue of tenant-scoped integrations. Deliberately a small, curated
 * set covering each category; a tenant that needs something bespoke uses the
 * `custom` integration with free-form field keys.
 */
export const TENANT_INTEGRATIONS: readonly IntegrationDescriptor[] = [
  {
    key: "stripe",
    label: "Stripe",
    category: "payments",
    description: "Tenant's own Stripe account keys for collecting payments.",
    rotationIntervalDays: 90,
    fields: [
      { key: "secret_key", label: "Secret key", hint: "sk_live_…" },
      { key: "webhook_secret", label: "Webhook signing secret", hint: "whsec_…" },
    ],
  },
  {
    key: "razorpay",
    label: "Razorpay",
    category: "payments",
    description: "Razorpay key id/secret for INR payment collection.",
    rotationIntervalDays: 90,
    fields: [
      { key: "key_id", label: "Key id" },
      { key: "key_secret", label: "Key secret" },
    ],
  },
  {
    key: "twilio",
    label: "Twilio",
    category: "messaging",
    description: "Twilio auth token for SMS/voice from the tenant's own number.",
    rotationIntervalDays: 180,
    fields: [
      { key: "account_sid", label: "Account SID" },
      { key: "auth_token", label: "Auth token" },
    ],
  },
  {
    key: "smtp",
    label: "SMTP",
    category: "email",
    description: "Outbound SMTP credentials for the tenant's transactional email.",
    rotationIntervalDays: 180,
    fields: [
      { key: "username", label: "Username" },
      { key: "password", label: "Password" },
    ],
  },
  {
    key: "s3",
    label: "S3-compatible storage",
    category: "storage",
    description: "Access keys for the tenant's own object storage bucket.",
    rotationIntervalDays: 180,
    fields: [
      { key: "access_key_id", label: "Access key id" },
      { key: "secret_access_key", label: "Secret access key" },
    ],
  },
  {
    key: "webhook",
    label: "Outbound webhook",
    category: "webhook",
    description: "Shared signing secret for the tenant's outbound webhooks.",
    rotationIntervalDays: 365,
    fields: [{ key: "signing_secret", label: "Signing secret" }],
  },
  {
    key: "custom",
    label: "Custom integration",
    category: "custom",
    description: "Free-form credentials for a bespoke tenant integration.",
    rotationIntervalDays: 365,
    fields: [{ key: "value", label: "Value" }],
  },
] as const

const BY_KEY = new Map(TENANT_INTEGRATIONS.map((i) => [i.key, i]))

export function getIntegrationDescriptor(key: string): IntegrationDescriptor | null {
  return BY_KEY.get(key) ?? null
}

const KEY_RE = /^[a-z][a-z0-9_]{1,48}$/

/** Validate an integration key against the catalogue. */
export function isKnownIntegration(key: string): boolean {
  return BY_KEY.has(key)
}

/**
 * Validate a field key for an integration. Known integrations constrain fields
 * to their declared set; `custom` (and only custom) accepts any well-formed key
 * so a tenant can model a bespoke integration without a code change.
 */
export function isValidField(integrationKey: string, fieldKey: string): boolean {
  if (!KEY_RE.test(fieldKey)) return false
  const desc = BY_KEY.get(integrationKey)
  if (!desc) return false
  if (desc.key === "custom") return true
  return desc.fields.some((f) => f.key === fieldKey)
}

/** Normalise a requested vault kind, defaulting unknown/empty to null (=auto). */
export function normalizeVaultChoice(raw: unknown): VaultKind | null {
  if (raw == null || raw === "") return null
  return isVaultKind(raw) ? raw : null
}

// ---------------------------------------------------------------------------
// Versions + rollback
// ---------------------------------------------------------------------------

export type SecretVersionRow = {
  version: number
  vaultKind: VaultKind
  active: boolean
  createdAt: string
  retiredAt: string | null
}

export type RollbackDecision =
  | { ok: true; targetVersion: number; fromVersion: number | null }
  | { ok: false; reason: string }

/**
 * Decide whether a rollback to `targetVersion` is valid over the known version
 * list. Rules (pure, so they are unit-tested directly):
 *   • the target must exist;
 *   • it must not already be the active version (no-op);
 *   • rolling back "restores" a prior encrypted version as the new active one.
 * Returns the currently-active version as `fromVersion` for the audit trail.
 */
export function decideRollback(versions: SecretVersionRow[], targetVersion: number): RollbackDecision {
  const target = versions.find((v) => v.version === targetVersion)
  if (!target) return { ok: false, reason: `Version ${targetVersion} does not exist` }
  const current = versions.find((v) => v.active) ?? null
  if (current && current.version === targetVersion) {
    return { ok: false, reason: `Version ${targetVersion} is already active` }
  }
  return { ok: true, targetVersion, fromVersion: current?.version ?? null }
}

/** The next version number given the existing rows (max + 1, or 1). */
export function nextVersion(versions: SecretVersionRow[]): number {
  return versions.reduce((max, v) => Math.max(max, v.version), 0) + 1
}

// ---------------------------------------------------------------------------
// Public projection (masked, plaintext-free)
// ---------------------------------------------------------------------------

export type PublicIntegrationField = {
  key: string
  label: string
  hint?: string
  present: boolean
  masked: string
  version: number | null
  vaultKind: VaultKind | null
  rotationStatus: RotationStatus
  lastRotatedAt: string | null
  ageDays: number | null
}

export type PublicIntegration = {
  key: string
  label: string
  category: IntegrationCategory
  description: string
  vaultKind: VaultKind
  vaultLabel: string
  health: HealthState
  lastTestedAt: string | null
  fields: PublicIntegrationField[]
}

export type IntegrationFieldState = {
  present: boolean
  version: number | null
  vaultKind: VaultKind | null
  lastRotatedAt: string | null
}

export type IntegrationState = {
  vaultKind: VaultKind
  health: HealthState
  lastTestedAt: string | null
  fields: Record<string, IntegrationFieldState>
}

/**
 * Project a descriptor + its persisted state into the masked public shape the
 * API returns. NEVER carries a plaintext value — only presence, mask, version
 * and metadata. `custom` integrations surface whatever fields the tenant has
 * populated, in addition to the declared `value` field.
 */
export function toPublicIntegration(
  descriptor: IntegrationDescriptor,
  state: IntegrationState,
  now: Date = new Date(),
): PublicIntegration {
  const declared = descriptor.fields.map((f) => f.key)
  const extra = Object.keys(state.fields).filter((k) => !declared.includes(k))
  const fieldKeys = descriptor.key === "custom" ? [...declared, ...extra] : declared

  const fields: PublicIntegrationField[] = fieldKeys.map((key) => {
    const fs = state.fields[key]
    const present = !!fs?.present
    const last = fs?.lastRotatedAt ?? null
    const label = descriptor.fields.find((f) => f.key === key)?.label ?? key
    const hint = descriptor.fields.find((f) => f.key === key)?.hint
    return {
      key,
      label,
      hint,
      present,
      masked: maskSecret(present),
      version: fs?.version ?? null,
      vaultKind: fs?.vaultKind ?? null,
      rotationStatus: rotationStatus(last, descriptor.rotationIntervalDays, now),
      lastRotatedAt: last,
      ageDays: last ? daysBetween(new Date(last), now) : null,
    }
  })

  return {
    key: descriptor.key,
    label: descriptor.label,
    category: descriptor.category,
    description: descriptor.description,
    vaultKind: state.vaultKind,
    vaultLabel: VAULT_KIND_LABELS[state.vaultKind],
    health: state.health,
    lastTestedAt: state.lastTestedAt,
    fields,
  }
}

/**
 * Fail-closed invariant mirrored from the platform model: no field may carry
 * anything but the fixed mask/empty marker, and no value-bearing field may have
 * crept into the public shape. Returns true when safe, throws otherwise.
 */
export function assertNoTenantSecretExposure(integrations: PublicIntegration[]): true {
  for (const integ of integrations) {
    for (const f of integ.fields) {
      if (f.masked !== SECRET_MASK && f.masked !== SECRET_EMPTY) {
        throw new Error(`Integration "${integ.key}.${f.key}" leaked a value through its mask`)
      }
      if ("value" in (f as Record<string, unknown>) || "plaintext" in (f as Record<string, unknown>)) {
        throw new Error(`Integration "${integ.key}.${f.key}" exposed a plaintext field`)
      }
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic idempotency key for a write action when the client did
 * not supply one. Two identical requests (same tenant, integration, field,
 * action and client key) collapse to the same key so a retry cannot create a
 * duplicate version. The value is NEVER part of the key (that would require
 * hashing plaintext); callers pass an explicit Idempotency-Key to dedupe true
 * retries of the SAME value.
 */
export function deriveIdempotencyKey(input: {
  tenantId: number
  integrationKey: string
  fieldKey: string
  action: "set" | "rotate" | "rollback"
  clientKey?: string | null
}): string {
  const { tenantId, integrationKey, fieldKey, action, clientKey } = input
  const base = `${tenantId}:${integrationKey}:${fieldKey}:${action}`
  return clientKey ? `${base}:${clientKey}` : base
}
