/**
 * Storage credential modes: static keys, temporary session-token credentials,
 * and assumed IAM roles.
 * ---------------------------------------------------------------------------
 * A tenant can connect their own object storage with one of three credential
 * strategies:
 *
 *   - "access_key"  → a long-lived IAM user access key + secret (the original
 *                     mode; still the default and the only option for non-AWS
 *                     S3-compatible vendors).
 *   - "temporary"   → short-lived credentials (access key + secret + session
 *                     token), e.g. minted by the customer's own STS. The stored
 *                     secret/token expire on their own; we just pass them
 *                     through and surface the expiry.
 *   - "iam_role"    → a cross-account IAM role the platform assumes with STS
 *                     (AWS S3 only). The customer never shares a standing
 *                     secret; they grant our principal `sts:AssumeRole` on a
 *                     role scoped to their bucket, optionally pinned with an
 *                     ExternalId. We exchange that for short-lived credentials
 *                     server-side on demand (see lib/storage/iam.ts).
 *
 * This module is intentionally pure (no `server-only`, no Node/AWS imports) so
 * the field-requirement + validation + redaction logic can be shared with the
 * client settings UI and unit-tested in isolation.
 */

export type AuthMode = "access_key" | "temporary" | "iam_role"

export const AUTH_MODES: readonly AuthMode[] = ["access_key", "temporary", "iam_role"]

const AUTH_MODE_SET = new Set<string>(AUTH_MODES)

export function isAuthMode(value: unknown): value is AuthMode {
  return typeof value === "string" && AUTH_MODE_SET.has(value)
}

/** Coerce any stored/posted value into a valid auth mode (defaults to access_key). */
export function normalizeAuthMode(value: unknown): AuthMode {
  return isAuthMode(value) ? value : "access_key"
}

export const AUTH_MODE_OPTIONS: { value: AuthMode; label: string; description: string }[] = [
  {
    value: "access_key",
    label: "Access key",
    description: "A long-lived IAM user access key ID and secret access key.",
  },
  {
    value: "temporary",
    label: "Temporary credentials",
    description: "Short-lived access key, secret and session token (e.g. from your own STS).",
  },
  {
    value: "iam_role",
    label: "IAM role (AssumeRole)",
    description: "We assume a cross-account role you grant us — no standing secret is shared. AWS S3 only.",
  },
]

/**
 * A parsed AWS IAM role ARN. Format:
 *   arn:<partition>:iam::<accountId>:role/<path/name>
 */
export type ParsedRoleArn = {
  partition: string
  accountId: string
  roleName: string
}

/**
 * Parse an IAM role ARN, returning its parts or null when it is not a
 * well-formed `role/...` ARN. Deliberately strict about the service (`iam`),
 * the empty region segment, and a 12-digit account id so a typo/paste of some
 * other ARN (a user, a bucket, a KMS key) is rejected before we ever try to
 * assume it.
 */
export function parseRoleArn(arn: string | null | undefined): ParsedRoleArn | null {
  if (!arn) return null
  const m = /^arn:(aws|aws-cn|aws-us-gov):iam::(\d{12}):role\/(.+)$/.exec(arn.trim())
  if (!m) return null
  const [, partition, accountId, roleName] = m
  if (!roleName || roleName.length > 512) return null
  return { partition, accountId, roleName }
}

export function isValidRoleArn(arn: string | null | undefined): boolean {
  return parseRoleArn(arn) !== null
}

/**
 * ExternalId charset per AWS: 2–1224 chars from a restricted set. We validate
 * shape only (never its secrecy) so a malformed value fails fast in the UI.
 */
export function isValidExternalId(value: string): boolean {
  return /^[\w+=,.@:/-]{2,1224}$/.test(value)
}

/** The subset of a connection this validator needs — mirrors ConnectionInput. */
export type AuthCredentialInput = {
  provider: string
  authMode?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string | null
  /** Present only when editing and the secret was intentionally left blank. */
  hasStoredSecret?: boolean
  sessionToken?: string | null
  hasStoredSessionToken?: boolean
  roleArn?: string | null
  externalId?: string | null
  roleSessionName?: string | null
}

/**
 * Validate that the credential fields required by the chosen auth mode are
 * present and well-formed. Returns a human-readable error string, or null when
 * the credentials are acceptable. Vendor-agnostic; callers layer bucket/region
 * requirements on top.
 */
export function validateAuthCredentials(input: AuthCredentialInput): string | null {
  const mode = normalizeAuthMode(input.authMode)

  if (mode === "iam_role") {
    if (input.provider !== "aws_s3") {
      return "IAM role credentials are only supported for Amazon S3"
    }
    if (!input.roleArn?.trim()) return "A role ARN is required for IAM role access"
    if (!isValidRoleArn(input.roleArn)) return "The role ARN is not a valid IAM role ARN"
    if (input.externalId && !isValidExternalId(input.externalId.trim())) {
      return "The external ID contains invalid characters"
    }
    if (input.roleSessionName && !/^[\w+=,.@-]{2,64}$/.test(input.roleSessionName.trim())) {
      return "The role session name is invalid"
    }
    return null
  }

  const hasSecret = Boolean(input.secretAccessKey?.trim()) || Boolean(input.hasStoredSecret)
  if (!input.accessKeyId?.trim()) return "An access key ID is required"
  if (!hasSecret) return "A secret access key is required"

  if (mode === "temporary") {
    const hasToken = Boolean(input.sessionToken?.trim()) || Boolean(input.hasStoredSessionToken)
    if (!hasToken) return "A session token is required for temporary credentials"
  }
  return null
}

/** Mask a secret-ish value for safe display/logging (keeps a short prefix). */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null
  if (value.length <= 8) return "****"
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`
}

/**
 * Produce a redacted, log-safe view of a connection's sensitive fields. Used
 * whenever a connection test/verification is recorded to the audit log so a
 * secret access key, session token or external ID can never be persisted in
 * plaintext next to the tenant's data.
 */
export function redactConnectionForLog(conn: {
  provider?: string
  authMode?: string | null
  bucket?: string | null
  region?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string | null
  sessionToken?: string | null
  roleArn?: string | null
  externalId?: string | null
}): Record<string, string | null> {
  return {
    provider: conn.provider ?? null,
    authMode: normalizeAuthMode(conn.authMode),
    bucket: conn.bucket ?? null,
    region: conn.region ?? null,
    accessKeyId: maskSecret(conn.accessKeyId),
    // Never echo these — presence only.
    secretAccessKey: conn.secretAccessKey ? "***redacted***" : null,
    sessionToken: conn.sessionToken ? "***redacted***" : null,
    roleArn: conn.roleArn ?? null,
    externalId: conn.externalId ? "***redacted***" : null,
  }
}
