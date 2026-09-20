import "server-only"
/**
 * SPEC 67 — Bearer API-key authentication for the public `/api/v1/*` surface.
 * ---------------------------------------------------------------------------
 * Distinct from lib/auth.ts (browser session cookies for the admin app):
 * this is for server-to-server callers presenting `Authorization: Bearer
 * mn_...`. Every check that fails closed — missing header, unknown key,
 * revoked, expired, or missing scope — returns null/false rather than
 * throwing, so callers uniformly respond 401/403 without leaking which
 * check failed.
 */
import { findKeyByPlaintext, touchKeyUsage, type ApiKeyRow } from "@/lib/api-keys-store"

export type ApiKeyAuth = {
  keyId: number
  tenantId: number
  scopes: string[]
}

export async function authenticateApiKey(request: Request): Promise<ApiKeyAuth | null> {
  const header = request.headers.get("authorization") || ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return null
  const row = await findKeyByPlaintext(match[1].trim())
  if (!row) return null
  if (!isKeyUsable(row)) return null
  void touchKeyUsage(row.id)
  return { keyId: row.id, tenantId: row.tenant_id, scopes: row.scopes ? row.scopes.split(",") : [] }
}

function isKeyUsable(row: ApiKeyRow): boolean {
  if (row.status !== "active") return false
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false
  return true
}

export function hasScope(auth: ApiKeyAuth, scope: string): boolean {
  return auth.scopes.includes(scope)
}
