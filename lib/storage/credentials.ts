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

// ---------------------------------------------------------------------------
// Safe provider-error logging
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  // AWS access key ids (long-lived AKIA, temporary ASIA, and other principals).
  /\b(AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|APKA)[A-Z0-9]{12,}\b/g,
  // Presigned-URL query material.
  /(X-Amz-(Signature|Credential|Security-Token)=)[^&\s"]+/gi,
  // "Credential=AKIA.../..." in authorization headers.
  /(Credential=)[^,\s"]+/gi,
  /(Signature=)[0-9a-f]{16,}/gi,
  // Anything long and base64-ish (secret keys are 40 chars, session tokens far longer).
  /\b[A-Za-z0-9/+=]{40,}\b/g,
]

/**
 * Scrub a provider/SDK error message before it is written to the audit log,
 * console or an HTTP response. SDK errors sometimes echo request material
 * (access key ids, signatures, session tokens); none of that may be persisted.
 */
export function sanitizeProviderMessage(message: unknown, maxLength = 240): string {
  let out = String(message ?? "")
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) && prefix.endsWith("=") ? `${prefix}[redacted]` : "[redacted]",
    )
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength)
}

// ---------------------------------------------------------------------------
// AssumeRole failure classification ("incorrect role" diagnostics)
// ---------------------------------------------------------------------------

export type AssumeRoleFailure =
  | "trust_denied"
  | "platform_principal_invalid"
  | "platform_principal_missing"
  | "role_invalid"
  | "region_disabled"
  | "throttled"
  | "network"
  | "unknown"

/**
 * Map an STS AssumeRole error to a stable failure code + an admin-actionable
 * message. Never includes raw SDK text (which can carry request identifiers).
 */
export function classifyAssumeRoleError(err: unknown): { code: AssumeRoleFailure; message: string } {
  const e = err as any
  const name: string = e?.name || e?.Code || ""
  const status: number | undefined = e?.$metadata?.httpStatusCode
  switch (name) {
    case "AccessDenied":
    case "AccessDeniedException":
      return {
        code: "trust_denied",
        message:
          "The role could not be assumed. Check that its trust policy allows the platform principal and requires the exact external ID shown for this connection.",
      }
    case "InvalidClientTokenId":
    case "SignatureDoesNotMatch":
    case "UnrecognizedClientException":
      return { code: "platform_principal_invalid", message: "The platform's AWS principal is misconfigured." }
    case "CredentialsProviderError":
      return { code: "platform_principal_missing", message: "No platform AWS principal is configured for AssumeRole." }
    case "MalformedPolicyDocument":
    case "PackedPolicyTooLarge":
    case "ValidationError":
    case "InvalidParameterValue":
      return { code: "role_invalid", message: "The role ARN or session parameters were rejected by AWS STS." }
    case "RegionDisabledException":
      return { code: "region_disabled", message: "AWS STS is not enabled in the selected region for this account." }
    case "Throttling":
    case "ThrottlingException":
      return { code: "throttled", message: "AWS STS throttled the request. Retry shortly." }
    case "TimeoutError":
    case "NetworkingError":
      return { code: "network", message: "Could not reach AWS STS." }
  }
  if (status === 403) return classifyAssumeRoleError({ name: "AccessDenied" })
  if (!status && /ECONN|ENOTFOUND|ETIMEDOUT|socket/i.test(String(e?.message ?? ""))) {
    return { code: "network", message: "Could not reach AWS STS." }
  }
  return { code: "unknown", message: "AssumeRole failed." }
}

// ---------------------------------------------------------------------------
// Tenant-scoped session policy + setup templates
// ---------------------------------------------------------------------------

function joinPrefix(pathPrefix: string | null | undefined, rest: string): string {
  const clean = (pathPrefix ?? "").replace(/^\/+|\/+$/g, "")
  return clean ? `${clean}/${rest}` : rest
}

/** The physical key prefix one tenant may touch inside a bucket. */
export function tenantObjectPrefix(pathPrefix: string | null | undefined, tenantId: number): string {
  return joinPrefix(pathPrefix, `t/${tenantId}/`)
}

/**
 * Inline session policy attached to every AssumeRole call. Effective permissions
 * are the INTERSECTION of this and the customer's role policy, so even if the
 * role grants the whole bucket, the minted credentials can only touch objects
 * under `<prefix>/t/<tenantId>/`. A guessed key for another tenant is therefore
 * denied by AWS itself, not merely by our key check.
 */
export function buildScopedSessionPolicy(input: {
  bucket: string
  pathPrefix?: string | null
  tenantId: number
  partition?: string
}): string {
  const partition = input.partition || "aws"
  const bucketArn = `arn:${partition}:s3:::${input.bucket}`
  const objectPrefix = tenantObjectPrefix(input.pathPrefix, input.tenantId)
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TenantObjects",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: `${bucketArn}/${objectPrefix}*`,
      },
      {
        Sid: "TenantList",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: bucketArn,
        Condition: { StringLike: { "s3:prefix": [`${objectPrefix}*`] } },
      },
      {
        Sid: "BucketMetadata",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:GetEncryptionConfiguration"],
        Resource: bucketArn,
      },
    ],
  })
}

/**
 * Trust + permission policy documents the customer pastes into their AWS
 * account. The trust policy pins the platform principal AND this connection's
 * external ID (confused-deputy protection: another tenant pointing at the same
 * role ARN cannot assume it because it never knows this external ID).
 */
export function buildIamPolicyTemplates(input: {
  platformPrincipalArn: string | null
  externalId: string | null
  bucket: string
  pathPrefix?: string | null
  partition?: string
}): { trustPolicy: string; permissionPolicy: string } {
  const partition = input.partition || "aws"
  const bucketArn = `arn:${partition}:s3:::${input.bucket || "<bucket>"}`
  const objectPrefix = joinPrefix(input.pathPrefix, "")
  const trust = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: input.platformPrincipalArn || "<platform-principal-arn>" },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": input.externalId || "<external-id>" } },
      },
    ],
  }
  const permission = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: `${bucketArn}/${objectPrefix}t/*`,
      },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetEncryptionConfiguration"],
        Resource: bucketArn,
      },
    ],
  }
  return { trustPolicy: JSON.stringify(trust, null, 2), permissionPolicy: JSON.stringify(permission, null, 2) }
}

/** A random, platform-generated external ID. Never accepted from the client. */
export function generateExternalId(): string {
  const bytes = new Uint8Array(18)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `muenot-${hex}`
}

// ---------------------------------------------------------------------------
// Region / ownership / activation decisions
// ---------------------------------------------------------------------------

/** Normalize an S3 GetBucketLocation LocationConstraint to a region id. */
export function normalizeBucketRegion(locationConstraint: string | null | undefined): string {
  if (!locationConstraint) return "us-east-1"
  if (locationConstraint === "EU") return "eu-west-1"
  return locationConstraint
}

/** The account expected to own the bucket: explicit setting, else the role's account. */
export function expectedBucketOwnerFor(conn: {
  expectedBucketOwner?: string | null
  roleArn?: string | null
  authMode?: string | null
}): string | null {
  const explicit = conn.expectedBucketOwner?.trim()
  if (explicit && /^\d{12}$/.test(explicit)) return explicit
  if (normalizeAuthMode(conn.authMode) === "iam_role") return parseRoleArn(conn.roleArn)?.accountId ?? null
  return null
}

export type VerificationStatus = "unverified" | "verified" | "failed" | "revoked"

export type ActivationCheckInput = {
  provider: string
  authMode?: string | null
  verificationStatus?: string | null
  verifiedFingerprint?: string | null
  currentFingerprint: string
  revokedAt?: string | Date | null
  credentialExpiresAt?: string | Date | null
}

/**
 * Whether a connection may be (or remain) active. A connection must be
 * verified against its CURRENT configuration (fingerprint match), must not be
 * revoked, and temporary credentials must not have expired. Managed Blob has
 * nothing customer-owned to verify.
 */
export function evaluateActivation(
  input: ActivationCheckInput,
  now: Date = new Date(),
): { allowed: true } | { allowed: false; reason: string; code: "revoked" | "unverified" | "stale" | "expired" | "failed" } {
  if (input.revokedAt) return { allowed: false, code: "revoked", reason: "This connection has been revoked" }
  if (input.provider === "vercel_blob") return { allowed: true }
  if (normalizeAuthMode(input.authMode) === "temporary" && input.credentialExpiresAt) {
    if (new Date(input.credentialExpiresAt).getTime() <= now.getTime()) {
      return { allowed: false, code: "expired", reason: "The temporary credentials have expired" }
    }
  }
  if (input.verificationStatus === "failed") {
    return { allowed: false, code: "failed", reason: "The last verification failed. Fix the issues and verify again" }
  }
  if (input.verificationStatus !== "verified") {
    return { allowed: false, code: "unverified", reason: "Verify the connection before activating it" }
  }
  if (!input.verifiedFingerprint || input.verifiedFingerprint !== input.currentFingerprint) {
    return { allowed: false, code: "stale", reason: "The configuration changed since it was verified. Verify again" }
  }
  return { allowed: true }
}

/**
 * Clamp a presigned URL lifetime so it never outlives the credentials that
 * signed it (a URL signed with temporary credentials stops working when they
 * expire anyway — this makes the advertised expiry honest). Returns 0 when the
 * credentials are already (almost) expired.
 */
export function clampTtlToCredentialExpiry(
  ttlSeconds: number,
  credentialExpiration: Date | string | null | undefined,
  now: Date = new Date(),
  safetySeconds = 5,
): number {
  if (!credentialExpiration) return ttlSeconds
  const remaining = Math.floor((new Date(credentialExpiration).getTime() - now.getTime()) / 1000) - safetySeconds
  return Math.max(0, Math.min(ttlSeconds, remaining))
}
