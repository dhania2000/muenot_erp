/**
 * Tenant-isolated object keys.
 * ---------------------------------------------------------------------------
 * Every object a tenant stores lives under a `t/<tenantId>/` prefix regardless
 * of provider. This gives us hard, structural isolation inside a customer's own
 * bucket (and inside shared Vercel Blob): the download proxy can reject any key
 * whose tenant segment does not match the caller's session tenant, so a guessed
 * or forged key can never reach another tenant's file.
 *
 * Pure and dependency-free so it is trivially unit-tested.
 */

const TENANT_PREFIX = "t"

/** Strip leading slashes and collapse traversal segments from a caller path. */
export function sanitizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/")
}

/** Build the canonical, tenant-namespaced key for a caller-supplied path. */
export function tenantKey(tenantId: number, path: string): string {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("tenantKey requires a positive integer tenantId")
  }
  const clean = sanitizePath(path)
  if (!clean) throw new Error("Storage path is empty after sanitization")
  return `${TENANT_PREFIX}/${tenantId}/${clean}`
}

/** The key prefix that scopes a listing to one tenant. */
export function tenantPrefix(tenantId: number): string {
  return `${TENANT_PREFIX}/${tenantId}/`
}

/** Extract the tenant id encoded in a key, or null when the shape is unexpected. */
export function tenantIdFromKey(key: string): number | null {
  const m = /^t\/(\d+)\//.exec(key)
  if (!m) return null
  const id = Number(m[1])
  return Number.isInteger(id) && id > 0 ? id : null
}

/** True when `key` belongs to `tenantId`. Used by the download proxy guard. */
export function keyBelongsToTenant(key: string, tenantId: number): boolean {
  return tenantIdFromKey(key) === tenantId
}
