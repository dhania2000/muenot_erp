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
 * Bearer API-key authentication for the public `/api/v1/*` surface.
 * ---------------------------------------------------------------------------
 * Distinct from lib/auth.ts (browser session cookies for the admin app):
 * this is for server-to-server callers presenting `Authorization: Bearer
 * mn_...`. Every check that fails closed — missing header, unknown key,
 * revoked, expired, or missing scope — returns null/false rather than
 * throwing, so callers uniformly respond 401/403 without leaking which
 * check failed.
 */
import { findKeyByPlaintext, touchKeyUsage, type ApiKeyEnvironment } from "@/lib/api-keys-store"
import { looksLikeOAuthToken, verifyOAuthAccessToken } from "@/lib/oauth/oauth-apps-store"

/**
 * OAuth access tokens share the `/api/v1` auth pipeline with API keys, so they
 * are mapped onto the same `ApiKeyAuth` shape. Their synthetic `keyId` is
 * offset into a disjoint numeric range so it can never collide with a real
 * `api_keys.id` for per-principal rate-limit buckets or idempotency records
 * (both of which key off `keyId`). The presence of `auth.oauth` is how the
 * handler tells the two principal kinds apart.
 */
export const OAUTH_KEY_ID_OFFSET = 2_000_000_000

export type ApiKeyAuth = {
  keyId: number
  tenantId: number
  name: string
  scopes: string[]
  environment: ApiKeyEnvironment
  ipRestrictions: string
  /** Present only when the principal is an OAuth access token, not an API key. */
  oauth?: { tokenId: number; appId: number }
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
  const presented = match[1].trim()

  // OAuth access tokens ride the same pipeline as API keys but resolve through
  // the OAuth store. Detect them by shape so a single Bearer scheme serves both.
  if (looksLikeOAuthToken(presented)) {
    const result = await verifyOAuthAccessToken(presented)
    if (!result.ok) {
      // Collapse app-level revocation into the caller-visible "revoked" reason.
      const reason = result.reason === "app_revoked" ? "revoked" : result.reason
      return { ok: false, reason }
    }
    const t = result.token
    return {
      ok: true,
      auth: {
        keyId: OAUTH_KEY_ID_OFFSET + t.tokenId,
        tenantId: t.tenantId,
        name: t.appName,
        scopes: t.scopes,
        environment: "live",
        ipRestrictions: "",
        oauth: { tokenId: t.tokenId, appId: t.appId },
      },
    }
  }

  const row = await findKeyByPlaintext(presented)
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

/** Back-compat helper ( shape): returns the auth or null on any failure. */
export async function authenticateApiKey(request: Request): Promise<ApiKeyAuth | null> {
  const result = await authenticateApiKeyResult(request)
  return result.ok ? result.auth : null
}

export function hasScope(auth: ApiKeyAuth, scope: string): boolean {
  return auth.scopes.includes(scope)
}
