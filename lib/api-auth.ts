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
