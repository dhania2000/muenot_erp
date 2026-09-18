/**
 * SPEC 32 — File classification + retention policy (pure).
 * ---------------------------------------------------------------------------
 * The data-governance vocabulary for centralized file metadata, kept free of
 * `server-only` and any Node/DB import so it can be shared with the settings UI
 * (labels/options) and unit-tested in isolation.
 *
 *   - Classification: the sensitivity tier of a file, which downstream access
 *     and delivery decisions can key on.
 *   - Retention:      how long a file must be kept before it becomes eligible
 *     for a retention-driven purge (a policy → a concrete expiry date).
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type FileClassification = "public" | "internal" | "confidential" | "restricted"

export const CLASSIFICATION_OPTIONS: {
  value: FileClassification
  label: string
  description: string
}[] = [
  { value: "public", label: "Public", description: "May be shared openly; no access restriction." },
  { value: "internal", label: "Internal", description: "Default. Visible to authorized tenant users." },
  {
    value: "confidential",
    label: "Confidential",
    description: "Sensitive business data; restricted to the owning module's authorized users.",
  },
  {
    value: "restricted",
    label: "Restricted",
    description: "Highly sensitive (PII, financial, legal); tightest access + audit.",
  },
]

const CLASSIFICATIONS = new Set<string>(CLASSIFICATION_OPTIONS.map((o) => o.value))

export const DEFAULT_CLASSIFICATION: FileClassification = "internal"

export function isClassification(value: string): value is FileClassification {
  return CLASSIFICATIONS.has(value)
}

export function normalizeClassification(value: string | null | undefined): FileClassification {
  return value && isClassification(value) ? value : DEFAULT_CLASSIFICATION
}

/** Ordered sensitivity rank (higher = more sensitive). */
export function classificationRank(value: FileClassification): number {
  return { public: 0, internal: 1, confidential: 2, restricted: 3 }[value]
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export type RetentionPolicyId =
  | "default"
  | "permanent"
  | "30d"
  | "90d"
  | "180d"
  | "1y"
  | "3y"
  | "7y"
  | "10y"

export type RetentionPolicyDefinition = {
  id: RetentionPolicyId
  label: string
  /** Number of days to keep, or null for indefinite retention. */
  days: number | null
  description: string
}

/**
 * `default` mirrors `7y` so financial/compliance documents are safe by default
 * (7 years is the common statutory floor for tax/audit records). Modules can
 * override per file.
 */
export const RETENTION_POLICIES: Record<RetentionPolicyId, RetentionPolicyDefinition> = {
  default: { id: "default", label: "Default (7 years)", days: 365 * 7, description: "Statutory default retention." },
  permanent: { id: "permanent", label: "Permanent", days: null, description: "Keep indefinitely; never auto-purged." },
  "30d": { id: "30d", label: "30 days", days: 30, description: "Short-lived / transient files." },
  "90d": { id: "90d", label: "90 days", days: 90, description: "Temporary working files." },
  "180d": { id: "180d", label: "180 days", days: 180, description: "Half-year retention." },
  "1y": { id: "1y", label: "1 year", days: 365, description: "One-year retention." },
  "3y": { id: "3y", label: "3 years", days: 365 * 3, description: "Medium-term records." },
  "7y": { id: "7y", label: "7 years", days: 365 * 7, description: "Long-term statutory records." },
  "10y": { id: "10y", label: "10 years", days: 365 * 10, description: "Extended statutory records." },
}

export const RETENTION_OPTIONS: RetentionPolicyDefinition[] = Object.values(RETENTION_POLICIES)

export const DEFAULT_RETENTION_POLICY: RetentionPolicyId = "default"

export function isRetentionPolicy(value: string): value is RetentionPolicyId {
  return value in RETENTION_POLICIES
}

export function normalizeRetentionPolicy(value: string | null | undefined): RetentionPolicyId {
  return value && isRetentionPolicy(value) ? value : DEFAULT_RETENTION_POLICY
}

/** Whole days a policy retains for, or null for permanent. */
export function retentionDays(policy: RetentionPolicyId): number | null {
  return RETENTION_POLICIES[policy].days
}

/**
 * Compute the concrete retention expiry `Date` for a policy anchored at `from`,
 * or null for a permanent policy. Deterministic and timezone-agnostic (adds
 * whole days in UTC-safe millisecond arithmetic).
 */
export function computeRetentionExpiry(
  policy: RetentionPolicyId | string | null | undefined,
  from: Date = new Date(),
): Date | null {
  const id = normalizeRetentionPolicy(typeof policy === "string" ? policy : undefined)
  const days = RETENTION_POLICIES[id].days
  if (days == null) return null
  const base = from instanceof Date && !Number.isNaN(from.getTime()) ? from : new Date()
  return new Date(base.getTime() + days * 86_400_000)
}

/** True when `expiresAt` is on or before `now` (i.e. eligible for purge). */
export function isRetentionExpired(
  expiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= now.getTime()
}
