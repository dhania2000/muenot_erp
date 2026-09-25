import "server-only"
import { createHash } from "node:crypto"
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts"
import {
  buildScopedSessionPolicy,
  classifyAssumeRoleError,
  normalizeAuthMode,
  parseRoleArn,
  type AssumeRoleFailure,
} from "./credentials"
import type { ResolvedConnection } from "./types"

/**
 * Server-side credential resolution for customer-owned S3.
 * ---------------------------------------------------------------------------
 *  - access_key → the stored long-lived key pair
 *  - temporary  → the stored key + secret + session token, refused after expiry
 *  - iam_role   → STS AssumeRole from the platform principal into the
 *                 customer's role, with the connection's ExternalId and an
 *                 inline session policy that narrows the minted credentials to
 *                 `<prefix>/t/<tenantId>/*`. Credentials live 15 minutes and
 *                 are cached per (tenant, connection, config fingerprint).
 *
 * Nothing here ever returns credentials to a client, and error messages are
 * pre-classified so no raw STS text reaches logs or responses.
 */

export type AwsCredentialIdentity = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}

export type CredentialErrorCode =
  | "missing"
  | "expired"
  | "revoked"
  | "role_invalid"
  | AssumeRoleFailure

export class StorageCredentialError extends Error {
  readonly code: CredentialErrorCode
  constructor(code: CredentialErrorCode, message: string) {
    super(message)
    this.name = "StorageCredentialError"
    this.code = code
  }
}

export const ASSUMED_ROLE_DURATION_SECONDS = 900
const REFRESH_WINDOW_MS = 60_000

type CacheEntry = { creds: AwsCredentialIdentity; expiresAt: number }
const cache = new Map<string, CacheEntry>()

/** SHA-256 over every field that influences where/how bytes are stored. */
export function connectionFingerprint(conn: ResolvedConnection): string {
  const h = (v: string | null | undefined) => (v ? createHash("sha256").update(v).digest("hex") : null)
  const material = [
    conn.provider,
    conn.bucket,
    conn.region ?? null,
    conn.endpoint ?? null,
    Boolean(conn.forcePathStyle),
    conn.pathPrefix ?? null,
    conn.serverSideEncryption ?? "none",
    normalizeAuthMode(conn.authMode),
    conn.accessKeyId ?? null,
    h(conn.secretAccessKey),
    h(conn.sessionToken ?? null),
    conn.roleArn ?? null,
    h(conn.externalId ?? null),
    conn.expectedBucketOwner ?? null,
  ]
  return createHash("sha256").update(JSON.stringify(material)).digest("hex")
}

function cacheKey(conn: ResolvedConnection): string {
  return `${conn.tenantId}:${conn.id}:${connectionFingerprint(conn)}`
}

/** Drop cached role credentials for a connection (on revoke/edit/delete). */
export function invalidateCredentialCache(tenantId: number, connectionId: number): void {
  const prefix = `${tenantId}:${connectionId}:`
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k)
}

/** Platform principal used as the AssumeRole caller. Optional explicit keys, else the SDK default chain. */
function platformStsClient(region: string): STSClient {
  const accessKeyId = process.env.STORAGE_PLATFORM_AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_PLATFORM_AWS_SECRET_ACCESS_KEY
  return new STSClient({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  })
}

/** ARN customers must trust; shown in the setup templates. */
export function platformPrincipalArn(): string | null {
  const v = process.env.STORAGE_PLATFORM_PRINCIPAL_ARN?.trim()
  return v || null
}

function sessionName(conn: ResolvedConnection): string {
  return `muenot-t${conn.tenantId}-c${conn.id}`.slice(0, 64)
}

async function assumeRole(conn: ResolvedConnection, stsFactory = platformStsClient): Promise<CacheEntry> {
  const parsed = parseRoleArn(conn.roleArn)
  if (!parsed) throw new StorageCredentialError("role_invalid", "The role ARN is not a valid IAM role ARN")
  if (!conn.externalId) throw new StorageCredentialError("missing", "The connection has no external ID")
  const sts = stsFactory(conn.region || "us-east-1")
  try {
    const res = await sts.send(
      new AssumeRoleCommand({
        RoleArn: conn.roleArn!,
        RoleSessionName: sessionName(conn),
        ExternalId: conn.externalId,
        DurationSeconds: ASSUMED_ROLE_DURATION_SECONDS,
        Policy: buildScopedSessionPolicy({
          bucket: conn.bucket,
          pathPrefix: conn.pathPrefix,
          tenantId: conn.tenantId,
          partition: parsed.partition,
        }),
      }),
    )
    const c = res.Credentials
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new StorageCredentialError("unknown", "AWS STS returned no credentials")
    }
    const expiration = c.Expiration ? new Date(c.Expiration) : new Date(Date.now() + ASSUMED_ROLE_DURATION_SECONDS * 1000)
    return {
      creds: {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration,
      },
      expiresAt: expiration.getTime(),
    }
  } catch (err) {
    if (err instanceof StorageCredentialError) throw err
    const { code, message } = classifyAssumeRoleError(err)
    throw new StorageCredentialError(code, message)
  }
}

/**
 * Resolve usable credentials for a connection right now. Throws a classified
 * StorageCredentialError for revoked, expired or un-assumable connections.
 */
export async function resolveCredentials(
  conn: ResolvedConnection,
  opts: { stsFactory?: (region: string) => STSClient; now?: number } = {},
): Promise<AwsCredentialIdentity> {
  if (conn.revokedAt) throw new StorageCredentialError("revoked", "This storage connection has been revoked")
  const mode = normalizeAuthMode(conn.authMode)
  const now = opts.now ?? Date.now()

  if (mode === "iam_role") {
    const key = cacheKey(conn)
    const hit = cache.get(key)
    if (hit && hit.expiresAt - now > REFRESH_WINDOW_MS) return hit.creds
    const fresh = await assumeRole(conn, opts.stsFactory)
    cache.set(key, fresh)
    return fresh.creds
  }

  if (!conn.accessKeyId || !conn.secretAccessKey) {
    throw new StorageCredentialError("missing", "Storage connection is missing access credentials")
  }
  if (mode === "temporary") {
    if (!conn.sessionToken) throw new StorageCredentialError("missing", "Temporary credentials need a session token")
    const expiration = conn.credentialExpiresAt ? new Date(conn.credentialExpiresAt) : undefined
    if (expiration && expiration.getTime() <= now) {
      throw new StorageCredentialError("expired", "The temporary storage credentials have expired")
    }
    return {
      accessKeyId: conn.accessKeyId,
      secretAccessKey: conn.secretAccessKey,
      sessionToken: conn.sessionToken,
      expiration,
    }
  }
  return { accessKeyId: conn.accessKeyId, secretAccessKey: conn.secretAccessKey }
}

/** Credential provider function for S3Client (called lazily, refreshed by the SDK). */
export function credentialProviderFor(conn: ResolvedConnection) {
  return () => resolveCredentials(conn)
}

/** GetCallerIdentity with the resolved credentials — confirms WHO we are acting as. */
export async function callerIdentity(
  conn: ResolvedConnection,
): Promise<{ account: string | null; arn: string | null }> {
  const creds = await resolveCredentials(conn)
  const sts = new STSClient({ region: conn.region || "us-east-1", credentials: creds })
  const res = await sts.send(new GetCallerIdentityCommand({}))
  return { account: res.Account ?? null, arn: res.Arn ?? null }
}

/** Test hook: clear the whole cache. */
export function __resetCredentialCacheForTests(): void {
  cache.clear()
}
