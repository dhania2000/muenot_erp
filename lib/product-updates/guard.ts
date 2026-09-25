import "server-only"

import { query } from "@/lib/db"
import { getCurrentTenant } from "@/lib/tenant-context"
import { resolveRoleContext } from "@/lib/platform-roles"
import type { SessionPayload } from "@/lib/auth"
import type { Viewer } from "@/lib/product-updates/model"

/**
 * Build the audience viewer from the acting session. The tenant is taken from
 * the per-request tenant context populated by getSession() (the effective
 * tenant, honoring impersonation / org-switch) and never from client input.
 */
export async function resolveViewer(session: SessionPayload): Promise<Viewer> {
  const tenantId = getCurrentTenant()?.tenantId ?? session.tenantId ?? null
  let plan: string | null = null
  if (tenantId != null) {
    try {
      const row = (await query<any[]>("SELECT plan FROM tenants WHERE id = ? LIMIT 1", [tenantId]))?.[0]
      plan = row?.plan ? String(row.plan) : null
    } catch {
      plan = null
    }
  }
  return { tenantId, role: session.role, tenantRole: session.tenantRole ?? null, plan }
}

/**
 * Authoring release notes is a platform-operator capability. Re-resolves the
 * role from the DB source of truth rather than trusting the token's hint.
 */
export async function isProductUpdateAuthor(session: SessionPayload): Promise<boolean> {
  try {
    const ctx = await resolveRoleContext({ userId: session.userId, impersonatedTenantId: session.impersonatedTenantId })
    return !!ctx && ctx.platformRole !== "none"
  } catch {
    return false
  }
}
