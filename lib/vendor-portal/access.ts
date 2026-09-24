import "server-only"
import { query } from "@/lib/db"
import { ensureVendorPortalSchema } from "@/lib/vendor-portal/schema"
import {
  DEFAULT_VENDOR_PORTAL_RESOURCES,
  VENDOR_PORTAL_RESOURCES,
  isVendorPortalResource,
  type VendorPortalResource,
} from "@/lib/vendor-portal/config"

/**
 * SPEC 119 — Vendor Portal · access control (Phase 1).
 *
 * Resolves which resources a given (tenant, vendor) pair may see. All reads are
 * scoped to the tenant AND the vendor; a portal user can never widen its own
 * grants (writes here happen only from the internal, staff-authenticated API).
 */

/** Pure: keep only the resources that are both valid and enabled. */
export function resolveGrantedResources(
  rows: { resource: string; enabled: number | boolean }[],
): VendorPortalResource[] {
  const granted = new Set<VendorPortalResource>()
  for (const row of rows) {
    if (!row.enabled) continue
    if (isVendorPortalResource(row.resource)) granted.add(row.resource)
  }
  // Preserve canonical ordering.
  return VENDOR_PORTAL_RESOURCES.filter((r) => granted.has(r))
}

/** The resources this vendor may access. Returns [] when none are enabled. */
export async function getVendorResources(tenantId: number, vendorId: number): Promise<VendorPortalResource[]> {
  await ensureVendorPortalSchema()
  const rows = await query<{ resource: string; enabled: number }[]>(
    `SELECT resource, enabled FROM vendor_portal_access WHERE tenant_id = ? AND vendor_id = ?`,
    [tenantId, vendorId],
  )
  return resolveGrantedResources(rows)
}

/** True when the vendor may access a specific resource. Fail-closed. */
export async function vendorCanAccess(
  tenantId: number,
  vendorId: number,
  resource: VendorPortalResource,
): Promise<boolean> {
  const granted = await getVendorResources(tenantId, vendorId)
  return granted.includes(resource)
}

/**
 * Replace a vendor's resource grants (internal/staff use only). Any resource
 * present in `resources` is enabled; every other known resource is disabled.
 */
export async function setVendorResources(
  tenantId: number,
  vendorId: number,
  resources: string[],
): Promise<VendorPortalResource[]> {
  await ensureVendorPortalSchema()
  const wanted = new Set(resources.filter(isVendorPortalResource))
  for (const resource of VENDOR_PORTAL_RESOURCES) {
    const enabled = wanted.has(resource) ? 1 : 0
    await query(
      `INSERT INTO vendor_portal_access (tenant_id, vendor_id, resource, enabled)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
      [tenantId, vendorId, resource, enabled],
    )
  }
  return getVendorResources(tenantId, vendorId)
}

/** Grant the default resource set to a vendor if it has no grants yet. */
export async function ensureDefaultVendorResources(tenantId: number, vendorId: number): Promise<void> {
  await ensureVendorPortalSchema()
  const existing = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM vendor_portal_access WHERE tenant_id = ? AND vendor_id = ?`,
    [tenantId, vendorId],
  )
  if (Number(existing[0]?.n ?? 0) > 0) return
  await setVendorResources(tenantId, vendorId, DEFAULT_VENDOR_PORTAL_RESOURCES)
}
