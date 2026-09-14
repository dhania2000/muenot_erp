import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { hasActionGrant } from "@/lib/permission-store"

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
