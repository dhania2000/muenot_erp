import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"

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
