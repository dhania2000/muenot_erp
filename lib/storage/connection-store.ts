import "server-only"
import { query } from "@/lib/db"
import {
  currentTenantId,
  scopedWhere,
  tenantInsert,
  tenantUpdate,
  tenantDelete,
} from "@/lib/tenant-scope"
import { encryptToken, decryptToken } from "@/lib/token-crypto"
import {
  getProviderDefinition,
  isStorageProviderId,
  normalizeEncryption,
  type StorageProviderId,
} from "./providers"
import type { HealthReport, ResolvedConnection } from "./types"
import {
  evaluateActivation,
  generateExternalId,
  normalizeAuthMode,
  sanitizeProviderMessage,
  validateAuthCredentials,
  type AuthMode,
  type VerificationStatus,
} from "./credentials"
import { connectionFingerprint, invalidateCredentialCache } from "./iam"

/**
 * Normalize an object key prefix: trim, strip leading/trailing slashes and any
 * empty/".." segments so a connection prefix can never escape the bucket root
 * or the tenant namespace. Returns null when empty.
 */
function normalizePathPrefix(value: string | null | undefined): string | null {
  if (!value) return null
  const clean = value
    .trim()
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/")
  return clean || null
}

/**
 * Tenant storage connection registry.
 * ---------------------------------------------------------------------------
 * Each customer (tenant) can register one or more storage backends and mark one
 * active. Rows are tenant-owned (see lib/tenant-tables.ts) so every read/write
 * here is automatically scoped through the tenant-scope helpers — a tenant can
 * never see or use another tenant's connection or credentials.
 *
 * Secrets (the S3 secret access key) are encrypted at rest with the shared
 * AES-256-GCM scheme (lib/token-crypto.ts) and are NEVER returned to the client
 * — only decrypted server-side when constructing a provider.
 */

const TABLE = "tenant_storage_connections"
const AUDIT_TABLE = "tenant_storage_audit"

let ensured = false

export async function ensureStorageSchema(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      provider VARCHAR(40) NOT NULL,
      name VARCHAR(190) NOT NULL,
      bucket VARCHAR(255) NOT NULL,
      region VARCHAR(120) DEFAULT NULL,
      endpoint VARCHAR(500) DEFAULT NULL,
      access_key_id VARCHAR(255) DEFAULT NULL,
      secret_access_key TEXT DEFAULT NULL,
      force_path_style TINYINT(1) NOT NULL DEFAULT 0,
      public_base_url VARCHAR(500) DEFAULT NULL,
      path_prefix VARCHAR(500) DEFAULT NULL,
      server_side_encryption VARCHAR(40) NOT NULL DEFAULT 'none',
      is_active TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_tsc_tenant (tenant_id),
      KEY idx_tsc_active (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      connection_id BIGINT DEFAULT NULL,
      action VARCHAR(40) NOT NULL,
      detail VARCHAR(500) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_tsca_tenant (tenant_id),
      KEY idx_tsca_conn (connection_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // additive columns for tables created by an earlier build. MySQL has
  // no portable "ADD COLUMN IF NOT EXISTS", so probe information_schema first.
  await ensureColumn(TABLE, "path_prefix", "ADD COLUMN `path_prefix` VARCHAR(500) DEFAULT NULL")
  await ensureColumn(
    TABLE,
    "server_side_encryption",
    "ADD COLUMN `server_side_encryption` VARCHAR(40) NOT NULL DEFAULT 'none'",
  )
  // Customer-owned IAM access (see database/migrations/2026-09-25-add-storage-iam-access.sql).
  for (const [col, frag] of IAM_COLUMNS) await ensureColumn(TABLE, col, frag)
  await ensureUploadIntentSchema()
  ensured = true
}

const IAM_COLUMNS: [string, string][] = [
  ["auth_mode", "ADD COLUMN `auth_mode` VARCHAR(20) NOT NULL DEFAULT 'access_key'"],
  ["session_token", "ADD COLUMN `session_token` TEXT DEFAULT NULL"],
  ["credential_expires_at", "ADD COLUMN `credential_expires_at` DATETIME DEFAULT NULL"],
  ["role_arn", "ADD COLUMN `role_arn` VARCHAR(2048) DEFAULT NULL"],
  ["external_id", "ADD COLUMN `external_id` VARCHAR(255) DEFAULT NULL"],
  ["expected_bucket_owner", "ADD COLUMN `expected_bucket_owner` VARCHAR(12) DEFAULT NULL"],
  ["verification_status", "ADD COLUMN `verification_status` VARCHAR(20) NOT NULL DEFAULT 'unverified'"],
  ["verified_fingerprint", "ADD COLUMN `verified_fingerprint` CHAR(64) DEFAULT NULL"],
  ["verified_at", "ADD COLUMN `verified_at` DATETIME DEFAULT NULL"],
  ["verification_detail", "ADD COLUMN `verification_detail` VARCHAR(500) DEFAULT NULL"],
  ["revoked_at", "ADD COLUMN `revoked_at` DATETIME DEFAULT NULL"],
  ["revoked_by", "ADD COLUMN `revoked_by` INT DEFAULT NULL"],
]

export const UPLOAD_INTENT_TABLE = "storage_upload_intents"

/** Direct-to-bucket (presigned PUT) upload intents; idempotent per tenant+key. */
async function ensureUploadIntentSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ${UPLOAD_INTENT_TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      idempotency_key VARCHAR(128) NOT NULL,
      request_fingerprint VARCHAR(700) NOT NULL,
      connection_id BIGINT DEFAULT NULL,
      provider VARCHAR(40) NOT NULL,
      object_key VARCHAR(1024) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      content_type VARCHAR(190) NOT NULL,
      declared_size BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      file_object_id BIGINT DEFAULT NULL,
      created_by INT DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      completed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sui_tenant_key (tenant_id, idempotency_key),
      KEY idx_sui_tenant_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function ensureColumn(table: string, column: string, alterFragment: string): Promise<void> {
  const rows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  if (Number(rows?.[0]?.c ?? 0) > 0) return
  await query(`ALTER TABLE \`${table}\` ${alterFragment}`).catch(() => {})
}

/** Append a tenant-scoped storage audit entry. Never throws to the caller. */
export async function logStorageAudit(
  action: string,
  opts: { connectionId?: number | null; detail?: string; userId?: number | null } = {},
): Promise<void> {
  try {
    await ensureStorageSchema()
    await tenantInsert(AUDIT_TABLE, {
      connection_id: opts.connectionId ?? null,
      action,
      detail: opts.detail ?? null,
      user_id: opts.userId ?? null,
    })
  } catch (err) {
    console.error("[v0] storage audit write failed:", err)
  }
}

export async function listStorageAudit(limit = 50): Promise<any[]> {
  await ensureStorageSchema()
  const { where, params } = scopedWhere(AUDIT_TABLE)
  return query<any[]>(
    `SELECT id, connection_id, action, detail, user_id, created_at FROM ${AUDIT_TABLE} ${where} ORDER BY id DESC LIMIT ?`,
    [...params, limit],
  )
}

export type ConnectionInput = {
  provider: StorageProviderId
  name: string
  bucket: string
  region?: string | null
  endpoint?: string | null
  accessKeyId?: string | null
  secretAccessKey?: string | null
  forcePathStyle?: boolean
  publicBaseUrl?: string | null
  pathPrefix?: string | null
  serverSideEncryption?: string | null
  authMode?: string | null
  sessionToken?: string | null
  credentialExpiresAt?: string | null
  roleArn?: string | null
  expectedBucketOwner?: string | null
}

/** A connection with all secrets redacted — safe to send to the client. */
export type MaskedConnection = {
  id: number
  provider: StorageProviderId
  providerLabel: string
  name: string
  bucket: string
  region: string | null
  endpoint: string | null
  accessKeyIdMasked: string | null
  hasSecret: boolean
  forcePathStyle: boolean
  publicBaseUrl: string | null
  pathPrefix: string | null
  serverSideEncryption: string
  isActive: boolean
  authMode: AuthMode
  hasSessionToken: boolean
  credentialExpiresAt: string | null
  roleArn: string | null
  /**
   * Shown only to this tenant's admins so they can paste it into their role's
   * trust policy. Generated server-side; never accepted from the client.
   */
  externalId: string | null
  expectedBucketOwner: string | null
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  verificationDetail: string | null
  /** Whether the stored verification still matches the current configuration. */
  verificationCurrent: boolean
  revokedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

function maskKey(id: string | null): string | null {
  if (!id) return null
  if (id.length <= 4) return "****"
  return `${id.slice(0, 4)}${"*".repeat(Math.max(4, id.length - 8))}${id.slice(-4)}`
}

function rowToMasked(r: any): MaskedConnection {
  const provider = String(r.provider) as StorageProviderId
  return {
    id: Number(r.id),
    provider,
    providerLabel: getProviderDefinition(provider)?.label ?? provider,
    name: r.name,
    bucket: r.bucket,
    region: r.region ?? null,
    endpoint: r.endpoint ?? null,
    accessKeyIdMasked: maskKey(r.access_key_id ?? null),
    hasSecret: Boolean(r.secret_access_key),
    forcePathStyle: Boolean(r.force_path_style),
    publicBaseUrl: r.public_base_url ?? null,
    pathPrefix: r.path_prefix ?? null,
    serverSideEncryption: normalizeEncryption(r.server_side_encryption),
    isActive: Boolean(r.is_active),
    authMode: normalizeAuthMode(r.auth_mode),
    hasSessionToken: Boolean(r.session_token),
    credentialExpiresAt: toIso(r.credential_expires_at),
    roleArn: r.role_arn ?? null,
    externalId: r.external_id ?? null,
    expectedBucketOwner: r.expected_bucket_owner ?? null,
    verificationStatus: normalizeVerification(r.verification_status),
    verifiedAt: toIso(r.verified_at),
    verificationDetail: r.verification_detail ?? null,
    verificationCurrent:
      Boolean(r.verified_fingerprint) && r.verified_fingerprint === connectionFingerprint(rowToResolved(r)),
    revokedAt: toIso(r.revoked_at),
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  }
}

function toIso(v: unknown): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function normalizeVerification(v: unknown): VerificationStatus {
  return v === "verified" || v === "failed" || v === "revoked" ? v : "unverified"
}

function rowToResolved(r: any): ResolvedConnection {
  return {
    authMode: normalizeAuthMode(r.auth_mode),
    sessionToken: decryptToken(r.session_token ?? null),
    credentialExpiresAt: toIso(r.credential_expires_at),
    roleArn: r.role_arn ?? null,
    externalId: r.external_id ?? null,
    expectedBucketOwner: r.expected_bucket_owner ?? null,
    verificationStatus: normalizeVerification(r.verification_status),
    verifiedFingerprint: r.verified_fingerprint ?? null,
    revokedAt: toIso(r.revoked_at),
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    provider: String(r.provider) as StorageProviderId,
    name: r.name,
    bucket: r.bucket,
    region: r.region ?? null,
    endpoint: r.endpoint ?? null,
    accessKeyId: r.access_key_id ?? null,
    secretAccessKey: decryptToken(r.secret_access_key ?? null),
    forcePathStyle: Boolean(r.force_path_style),
    publicBaseUrl: r.public_base_url ?? null,
    pathPrefix: r.path_prefix ?? null,
    serverSideEncryption: normalizeEncryption(r.server_side_encryption),
    isActive: Boolean(r.is_active),
  }
}

export async function listConnections(): Promise<MaskedConnection[]> {
  await ensureStorageSchema()
  const { where, params } = scopedWhere(TABLE)
  const rows = await query<any[]>(`SELECT * FROM ${TABLE} ${where} ORDER BY is_active DESC, id DESC`, params)
  return rows.map(rowToMasked)
}

/** The active connection for the current tenant, decrypted — or null. */
export async function getActiveConnection(): Promise<ResolvedConnection | null> {
  await ensureStorageSchema()
  const { where, params } = scopedWhere(TABLE, "is_active = 1 AND revoked_at IS NULL")
  const rows = await query<any[]>(`SELECT * FROM ${TABLE} ${where} LIMIT 1`, params)
  return rows[0] ? rowToResolved(rows[0]) : null
}

export async function getResolvedConnectionById(id: number): Promise<ResolvedConnection | null> {
  await ensureStorageSchema()
  const { where, params } = scopedWhere(TABLE, "id = ?", [id])
  const rows = await query<any[]>(`SELECT * FROM ${TABLE} ${where} LIMIT 1`, params)
  return rows[0] ? rowToResolved(rows[0]) : null
}

function validate(
  input: ConnectionInput,
  stored?: { hasSecret: boolean; hasSessionToken: boolean },
): string | null {
  if (!isStorageProviderId(input.provider)) return "Unknown storage provider"
  const def = getProviderDefinition(input.provider)!
  if (!input.name?.trim()) return "A connection name is required"
  if (input.name.trim().length > 190) return "The connection name is too long"
  if (input.provider !== "vercel_blob") {
    if (!input.bucket?.trim()) return "A bucket name is required"
    if (!/^[a-z0-9][a-z0-9.\-_]{1,254}$/i.test(input.bucket.trim())) return "The bucket name is invalid"
    if (def.endpoint === "required" && !input.endpoint?.trim()) return "An endpoint URL is required for this provider"
    if (def.region === "required" && !input.region?.trim()) return "A region is required for this provider"
    if (input.endpoint?.trim() && !/^https:\/\//i.test(input.endpoint.trim()) && process.env.NODE_ENV === "production") {
      return "The endpoint must use HTTPS"
    }
    const authErr = validateAuthCredentials({
      provider: input.provider,
      authMode: input.authMode,
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      hasStoredSecret: stored?.hasSecret,
      sessionToken: input.sessionToken,
      hasStoredSessionToken: stored?.hasSessionToken,
      roleArn: input.roleArn,
    })
    if (authErr) return authErr
    const mode = normalizeAuthMode(input.authMode)
    if (mode === "temporary" && input.credentialExpiresAt) {
      const t = new Date(input.credentialExpiresAt).getTime()
      if (Number.isNaN(t)) return "The credential expiry is not a valid date"
      if (t <= Date.now()) return "The temporary credentials have already expired"
    }
    if (input.expectedBucketOwner?.trim() && !/^\d{12}$/.test(input.expectedBucketOwner.trim())) {
      return "The expected bucket owner must be a 12-digit AWS account ID"
    }
  }
  return null
}

/** Credential columns for the chosen auth mode; other modes' secrets are cleared. */
function credentialColumns(input: ConnectionInput): Record<string, any> {
  const mode = input.provider === "vercel_blob" ? "access_key" : normalizeAuthMode(input.authMode)
  const cols: Record<string, any> = {
    auth_mode: mode,
    expected_bucket_owner: input.expectedBucketOwner?.trim() || null,
  }
  if (mode === "iam_role") {
    cols.role_arn = input.roleArn!.trim()
    cols.access_key_id = null
    cols.secret_access_key = null
    cols.session_token = null
    cols.credential_expires_at = null
  } else {
    cols.role_arn = null
    cols.access_key_id = input.accessKeyId?.trim() || null
    if (mode === "access_key") {
      cols.session_token = null
      cols.credential_expires_at = null
    } else {
      cols.credential_expires_at = input.credentialExpiresAt ? new Date(input.credentialExpiresAt) : null
    }
  }
  return cols
}

export async function createConnection(
  input: ConnectionInput,
  userId?: number,
): Promise<{ id: number } | { error: string }> {
  await ensureStorageSchema()
  const err = validate(input)
  if (err) return { error: err }
  const def = getProviderDefinition(input.provider)!
  const creds = credentialColumns(input)
  const { insertId } = await tenantInsert(TABLE, {
    provider: input.provider,
    name: input.name.trim(),
    bucket: (input.bucket ?? "").trim(),
    region: input.region?.trim() || def.defaultRegion || null,
    endpoint: input.endpoint?.trim() || null,
    ...creds,
    secret_access_key:
      creds.auth_mode !== "iam_role" && input.secretAccessKey ? encryptToken(input.secretAccessKey) : null,
    session_token:
      creds.auth_mode === "temporary" && input.sessionToken ? encryptToken(input.sessionToken) : null,
    // Confused-deputy protection: the platform mints the ExternalId; it is
    // unique per connection so another tenant cannot reuse this role.
    external_id: creds.auth_mode === "iam_role" ? generateExternalId() : null,
    force_path_style: input.forcePathStyle ?? def.forcePathStyle ? 1 : 0,
    public_base_url: input.publicBaseUrl?.trim() || null,
    path_prefix: normalizePathPrefix(input.pathPrefix),
    server_side_encryption: normalizeEncryption(input.serverSideEncryption),
    verification_status: "unverified",
    is_active: 0,
    created_by: userId ?? null,
  })
  return { id: insertId }
}

export async function updateConnection(
  id: number,
  input: ConnectionInput,
): Promise<{ ok: true; deactivated: boolean } | { error: string }> {
  await ensureStorageSchema()
  const before = await getResolvedConnectionById(id)
  if (!before) return { error: "Connection not found" }
  if (before.revokedAt) return { error: "A revoked connection cannot be edited" }
  const err = validate(input, { hasSecret: Boolean(before.secretAccessKey), hasSessionToken: Boolean(before.sessionToken) })
  if (err) return { error: err }
  const def = getProviderDefinition(input.provider)!
  const creds = credentialColumns(input)
  const set: Record<string, any> = {
    provider: input.provider,
    name: input.name.trim(),
    bucket: (input.bucket ?? "").trim(),
    region: input.region?.trim() || def.defaultRegion || null,
    endpoint: input.endpoint?.trim() || null,
    ...creds,
    force_path_style: input.forcePathStyle ?? def.forcePathStyle ? 1 : 0,
    public_base_url: input.publicBaseUrl?.trim() || null,
    path_prefix: normalizePathPrefix(input.pathPrefix),
    server_side_encryption: normalizeEncryption(input.serverSideEncryption),
  }
  // Only overwrite secrets when new ones are supplied; blank keeps the stored
  // value (so editing other fields is non-destructive). Switching to iam_role
  // wipes them via credentialColumns.
  if (creds.auth_mode !== "iam_role") {
    if (input.secretAccessKey) set.secret_access_key = encryptToken(input.secretAccessKey)
    if (creds.auth_mode === "temporary") {
      if (input.sessionToken) set.session_token = encryptToken(input.sessionToken)
      else delete set.session_token
    }
  } else if (!before.externalId) {
    set.external_id = generateExternalId()
  }
  const affected = await tenantUpdate(TABLE, set, "id = ?", [id])
  if (affected === 0) return { error: "Connection not found" }

  invalidateCredentialCache(before.tenantId, id)
  const after = await getResolvedConnectionById(id)
  let deactivated = false
  if (after && connectionFingerprint(after) !== before.verifiedFingerprint) {
    // Any storage-affecting change invalidates the verification; an active
    // connection is taken offline until it is verified again.
    await tenantUpdate(
      TABLE,
      { verification_status: "unverified", verified_fingerprint: null, is_active: 0 },
      "id = ?",
      [id],
    )
    deactivated = before.isActive
  }
  return { ok: true, deactivated }
}

/**
 * Mark one connection active for the current tenant, deactivating the rest.
 * Refused unless the connection passed verification for its CURRENT config,
 * is not revoked and (for temporary credentials) has not expired.
 */
export async function setActiveConnection(id: number): Promise<{ ok: true } | { error: string; code?: string }> {
  await ensureStorageSchema()
  const existing = await getResolvedConnectionById(id)
  if (!existing) return { error: "Connection not found" }
  const gate = evaluateActivation({
    provider: existing.provider,
    authMode: existing.authMode,
    verificationStatus: existing.verificationStatus,
    verifiedFingerprint: existing.verifiedFingerprint,
    currentFingerprint: connectionFingerprint(existing),
    revokedAt: existing.revokedAt,
    credentialExpiresAt: existing.credentialExpiresAt,
  })
  if (!gate.allowed) return { error: gate.reason, code: gate.code }
  await tenantUpdate(TABLE, { is_active: 0 }, "is_active = 1")
  await tenantUpdate(TABLE, { is_active: 1 }, "id = ?", [id])
  return { ok: true }
}

/**
 * Persist the outcome of a pre-activation verification, bound to the exact
 * configuration fingerprint that was verified. A failed verification also
 * takes an active connection offline.
 */
export async function recordVerification(id: number, report: HealthReport): Promise<void> {
  await ensureStorageSchema()
  const conn = await getResolvedConnectionById(id)
  if (!conn || conn.revokedAt) return
  const failed = report.checks.filter((c) => c.status === "fail")
  const detail = failed.length
    ? sanitizeProviderMessage(failed.map((c) => `${c.id}: ${c.detail ?? "failed"}`).join("; "), 480)
    : null
  await tenantUpdate(
    TABLE,
    report.ok
      ? {
          verification_status: "verified",
          verified_fingerprint: connectionFingerprint(conn),
          verified_at: new Date(),
          verification_detail: null,
        }
      : {
          verification_status: "failed",
          verified_fingerprint: null,
          verified_at: new Date(),
          verification_detail: detail,
          is_active: 0,
        },
    "id = ?",
    [id],
  )
}

/**
 * Revoke a connection: deactivate it, destroy the stored secrets and drop any
 * cached role credentials. Irreversible — create a new connection to reconnect.
 * Presigned URLs already issued stop working when the credentials behind them
 * are disabled on the customer's side (and assumed-role URLs within ≤15 min).
 */
export async function revokeConnection(id: number, userId?: number): Promise<{ ok: true } | { error: string }> {
  await ensureStorageSchema()
  const conn = await getResolvedConnectionById(id)
  if (!conn) return { error: "Connection not found" }
  if (conn.revokedAt) return { ok: true }
  await tenantUpdate(
    TABLE,
    {
      is_active: 0,
      verification_status: "revoked",
      verified_fingerprint: null,
      secret_access_key: null,
      session_token: null,
      revoked_at: new Date(),
      revoked_by: userId ?? null,
    },
    "id = ?",
    [id],
  )
  invalidateCredentialCache(conn.tenantId, id)
  return { ok: true }
}

/** Deactivate all connections (fall back to the default platform storage). */
export async function deactivateAll(): Promise<void> {
  await ensureStorageSchema()
  await tenantUpdate(TABLE, { is_active: 0 }, "is_active = 1")
}

export async function deleteConnection(id: number): Promise<{ ok: true } | { error: string }> {
  await ensureStorageSchema()
  const affected = await tenantDelete(TABLE, "id = ?", [id])
  return affected > 0 ? { ok: true } : { error: "Connection not found" }
}

/** Assert the current tenant owns the row — extra guard for mutations. */
export function assertTenantScope(): number {
  return currentTenantId()
}
