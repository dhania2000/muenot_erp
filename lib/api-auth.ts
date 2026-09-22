import "server-only"
// Browser-session guards and public API-key authentication intentionally coexist.
// Keep these exports stable: existing application routes import this module.
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { hasActionGrant } from "@/lib/permission-store"
import { getCurrentTenant } from "@/lib/tenant-context"

/**
 * Requires an active session with the given feature slug granted.
 * Returns the session, or null if unauthorized (caller should respond 401/403).
 */
export async function requireFeature(featureSlug: string) {
  const session = await getSession()
  if (!session) return null
  const allowed = await userHasFeature(session.userId, session.role, featureSlug)
  if (!allowed) return null
  return session
}

/**
 * Requires an active session granted a module-specific EXTENDED action
 * (Phase 44) — e.g. `finance.gst_filing` / `file_return`. Admins always pass;
 * everyone else must have a non-"none" grant (explicit, or derived from the
 * action's base-CRUD fallback). Returns the session or null (respond 403).
 */
export async function requireModuleAction(moduleKey: string, actionKey: string) {
  const session = await getSession()
  if (!session) return null
  if (session.role === "admin") return session
  const allowed = await hasActionGrant(session.userId, session.role, moduleKey, actionKey)
  if (!allowed) return null
  return session
}

/**
 * The tenant id for the current authenticated request, derived from the
 * verified session (populated by getSession). Returns null when there is no
 * session or no tenant could be resolved. NEVER accepts a client-supplied
 * tenant id — call this instead of reading tenant_id from request input.
 */
export async function getTenantId(): Promise<number | null> {
  const session = await getSession()
  if (!session) return null
  if (session.tenantId != null) return session.tenantId
  return getCurrentTenant()?.tenantId ?? null
}

/**
 * Requires an active session AND a resolved tenant. Returns `{ session,
 * tenantId }`, or null if unauthenticated / no tenant (caller responds
 * 401/403). Use in tenant-scoped routes so data access is always bounded to
 * the acting tenant.
 */
export async function requireTenant() {
  const session = await getSession()
  if (!session) return null
  const tenantId = session.tenantId ?? getCurrentTenant()?.tenantId ?? null
  if (tenantId == null) return null
  return { session, tenantId }
}

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
import { findKeyByPlaintext, touchKeyUsage, type ApiKeyEnvironment } from "@/lib/api-keys-store"

export type ApiKeyAuth = {
  keyId: number
  tenantId: number
  name: string
  scopes: string[]
  environment: ApiKeyEnvironment
  ipRestrictions: string
}

/**
 * Distinguishes WHY a key failed to authenticate so the platform handler can
 * emit standardized errors + audit trail without leaking specifics to the
 * caller. `expired` and `revoked` collapse to 401 for the caller but are
 * recorded distinctly.
 */
export type ApiKeyAuthResult =
  | { ok: true; auth: ApiKeyAuth }
  | { ok: false; reason: "missing" | "unknown" | "revoked" | "expired"; keyId?: number; tenantId?: number }

export async function authenticateApiKeyResult(request: Request): Promise<ApiKeyAuthResult> {
  const header = request.headers.get("authorization") || ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return { ok: false, reason: "missing" }
  const row = await findKeyByPlaintext(match[1].trim())
  if (!row) return { ok: false, reason: "unknown" }
  if (row.status !== "active") return { ok: false, reason: "revoked", keyId: row.id, tenantId: row.tenant_id }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now())
    return { ok: false, reason: "expired", keyId: row.id, tenantId: row.tenant_id }
  void touchKeyUsage(row.id)
  return {
    ok: true,
    auth: {
      keyId: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      scopes: row.scopes ? row.scopes.split(",") : [],
      environment: row.environment,
      ipRestrictions: row.ip_restrictions ?? "",
    },
  }
}

/** Back-compat helper (SPEC 67 shape): returns the auth or null on any failure. */
export async function authenticateApiKey(request: Request): Promise<ApiKeyAuth | null> {
  const result = await authenticateApiKeyResult(request)
  return result.ok ? result.auth : null
}

export function hasScope(auth: ApiKeyAuth, scope: string): boolean {
  return auth.scopes.includes(scope)
}
