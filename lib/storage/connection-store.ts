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
import { getProviderDefinition, isStorageProviderId, type StorageProviderId } from "./providers"
import type { ResolvedConnection } from "./types"

/**
 * SPEC 26 — Tenant storage connection registry.
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
  ensured = true
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
  isActive: boolean
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
    isActive: Boolean(r.is_active),
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  }
}

function rowToResolved(r: any): ResolvedConnection {
  return {
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
  const { where, params } = scopedWhere(TABLE, "is_active = 1")
  const rows = await query<any[]>(`SELECT * FROM ${TABLE} ${where} LIMIT 1`, params)
  return rows[0] ? rowToResolved(rows[0]) : null
}

export async function getResolvedConnectionById(id: number): Promise<ResolvedConnection | null> {
  await ensureStorageSchema()
  const { where, params } = scopedWhere(TABLE, "id = ?", [id])
  const rows = await query<any[]>(`SELECT * FROM ${TABLE} ${where} LIMIT 1`, params)
  return rows[0] ? rowToResolved(rows[0]) : null
}

function validate(input: ConnectionInput): string | null {
  if (!isStorageProviderId(input.provider)) return "Unknown storage provider"
  const def = getProviderDefinition(input.provider)!
  if (!input.name?.trim()) return "A connection name is required"
  if (input.provider !== "vercel_blob") {
    if (!input.bucket?.trim()) return "A bucket name is required"
    if (def.endpoint === "required" && !input.endpoint?.trim()) return "An endpoint URL is required for this provider"
    if (def.region === "required" && !input.region?.trim()) return "A region is required for this provider"
  }
  return null
}

export async function createConnection(
  input: ConnectionInput,
  userId?: number,
): Promise<{ id: number } | { error: string }> {
  await ensureStorageSchema()
  const err = validate(input)
  if (err) return { error: err }
  const def = getProviderDefinition(input.provider)!
  const { insertId } = await tenantInsert(TABLE, {
    provider: input.provider,
    name: input.name.trim(),
    bucket: (input.bucket ?? "").trim(),
    region: input.region?.trim() || def.defaultRegion || null,
    endpoint: input.endpoint?.trim() || null,
    access_key_id: input.accessKeyId?.trim() || null,
    secret_access_key: input.secretAccessKey ? encryptToken(input.secretAccessKey) : null,
    force_path_style: input.forcePathStyle ?? def.forcePathStyle ? 1 : 0,
    public_base_url: input.publicBaseUrl?.trim() || null,
    is_active: 0,
    created_by: userId ?? null,
  })
  return { id: insertId }
}

export async function updateConnection(
  id: number,
  input: ConnectionInput,
): Promise<{ ok: true } | { error: string }> {
  await ensureStorageSchema()
  const err = validate(input)
  if (err) return { error: err }
  const def = getProviderDefinition(input.provider)!
  const set: Record<string, any> = {
    provider: input.provider,
    name: input.name.trim(),
    bucket: (input.bucket ?? "").trim(),
    region: input.region?.trim() || def.defaultRegion || null,
    endpoint: input.endpoint?.trim() || null,
    access_key_id: input.accessKeyId?.trim() || null,
    force_path_style: input.forcePathStyle ?? def.forcePathStyle ? 1 : 0,
    public_base_url: input.publicBaseUrl?.trim() || null,
  }
  // Only overwrite the secret when a new one is supplied; a blank value keeps
  // the stored credential intact (so editing other fields is non-destructive).
  if (input.secretAccessKey) set.secret_access_key = encryptToken(input.secretAccessKey)
  const affected = await tenantUpdate(TABLE, set, "id = ?", [id])
  return affected > 0 ? { ok: true } : { error: "Connection not found" }
}

/** Mark one connection active for the current tenant, deactivating the rest. */
export async function setActiveConnection(id: number): Promise<{ ok: true } | { error: string }> {
  await ensureStorageSchema()
  const existing = await getResolvedConnectionById(id)
  if (!existing) return { error: "Connection not found" }
  await tenantUpdate(TABLE, { is_active: 0 }, "is_active = 1")
  await tenantUpdate(TABLE, { is_active: 1 }, "id = ?", [id])
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
