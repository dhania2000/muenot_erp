import "server-only"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { resolveTeamKeys, SavedViewError, type Viewer } from "./store"
import { featureForTable, isValidTableKey } from "./table-registry"
import type { ViewVisibility } from "./types"

/**
 * Resolve the acting viewer from the verified session. The tenant is always the
 * session tenant — a request without one is rejected rather than falling back
 * to a shared "tenant 0" bucket.
 */
export async function resolveViewer(): Promise<Viewer | null> {
  const session = await getSession()
  if (!session) return null
  const tenantId = Number(session.tenantId)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new SavedViewError("No tenant is associated with this session", 403)
  }
  const tenantRole = session.tenantRole ?? (session.role === "admin" ? "tenant_admin" : "employee")
  const roleKeys = new Set<string>([session.role, tenantRole])
  const teamKeys = await resolveTeamKeys(tenantId, session.userId)
  return { userId: session.userId, tenantId, role: session.role, tenantRole, roleKeys, teamKeys }
}

/**
 * Validate the table key and require the feature that gates the table's data.
 * Unregistered keys are only allowed for private (personal) views.
 */
export async function assertTableAccess(
  viewer: Viewer,
  tableKey: unknown,
  visibility: ViewVisibility = "private",
): Promise<string> {
  if (!isValidTableKey(tableKey)) throw new SavedViewError("Invalid table key", 400)
  const feature = featureForTable(tableKey)
  if (!feature) {
    if (visibility !== "private") throw new SavedViewError("Only personal views are allowed for this table", 403)
    return tableKey
  }
  const allowed = await userHasFeature(viewer.userId, viewer.role, feature)
  if (!allowed) throw new SavedViewError("You do not have access to this table", 403)
  return tableKey
}

export const MAX_VIEW_NAME = 160

export function validateViewName(raw: unknown): string {
  if (typeof raw !== "string") throw new SavedViewError("A view name is required", 400)
  const name = raw.trim()
  if (!name) throw new SavedViewError("A view name is required", 400)
  if (name.length > MAX_VIEW_NAME) throw new SavedViewError(`View name must be ${MAX_VIEW_NAME} characters or fewer`, 400)
  return name
}
