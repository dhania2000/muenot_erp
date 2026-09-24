import "server-only"
import { query } from "@/lib/db"
import { ensurePortalSchema } from "@/lib/portal/schema"
import {
  DEFAULT_PORTAL_RESOURCES,
  PORTAL_RESOURCES,
  isPortalResource,
  type PortalResource,
} from "@/lib/portal/config"

/**
 * SPEC 118 — Client Portal · access control (Phase 1).
 *
 * Resolves which resources a given (tenant, client) pair may see. All reads are
 * scoped to the tenant AND the client; a portal user can never widen its own
 * grants (writes here happen only from the internal, staff-authenticated API).
 */

/** Pure: keep only the resources that are both valid and enabled. */
export function resolveGrantedResources(rows: { resource: string; enabled: number | boolean }[]): PortalResource[] {
  const granted = new Set<PortalResource>()
  for (const row of rows) {
    if (!row.enabled) continue
    if (isPortalResource(row.resource)) granted.add(row.resource)
  }
  // Preserve canonical ordering.
  return PORTAL_RESOURCES.filter((r) => granted.has(r))
}

/** The resources this client may access. Returns [] when none are enabled. */
export async function getClientResources(tenantId: number, clientId: number): Promise<PortalResource[]> {
  await ensurePortalSchema()
  const rows = await query<{ resource: string; enabled: number }[]>(
    `SELECT resource, enabled FROM client_portal_access WHERE tenant_id = ? AND client_id = ?`,
    [tenantId, clientId],
  )
  return resolveGrantedResources(rows)
}

/** True when the client may access a specific resource. Fail-closed. */
export async function clientCanAccess(
  tenantId: number,
  clientId: number,
  resource: PortalResource,
): Promise<boolean> {
  const granted = await getClientResources(tenantId, clientId)
  return granted.includes(resource)
}

/**
 * Replace a client's resource grants (internal/staff use only). Any resource
 * present in `resources` is enabled; every other known resource is disabled.
 */
export async function setClientResources(
  tenantId: number,
  clientId: number,
  resources: string[],
): Promise<PortalResource[]> {
  await ensurePortalSchema()
  const wanted = new Set(resources.filter(isPortalResource))
  for (const resource of PORTAL_RESOURCES) {
    const enabled = wanted.has(resource) ? 1 : 0
    await query(
      `INSERT INTO client_portal_access (tenant_id, client_id, resource, enabled)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
      [tenantId, clientId, resource, enabled],
    )
  }
  return getClientResources(tenantId, clientId)
}

/** Grant the default resource set to a client if it has no grants yet. */
export async function ensureDefaultClientResources(tenantId: number, clientId: number): Promise<void> {
  await ensurePortalSchema()
  const existing = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM client_portal_access WHERE tenant_id = ? AND client_id = ?`,
    [tenantId, clientId],
  )
  if (Number(existing[0]?.n ?? 0) > 0) return
  await setClientResources(tenantId, clientId, DEFAULT_PORTAL_RESOURCES)
}
