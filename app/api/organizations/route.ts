import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listMembershipsForUser } from "@/lib/tenant-membership"
import { resolveTenantIdForUser } from "@/lib/tenant-service"

/**
 * List the organizations the authenticated user can act in — i.e. the valid
 * targets for the organization switcher.
 *
 * SECURITY: the set is derived ENTIRELY from the verified session's user id via
 * `listMembershipsForUser`, which only returns ACTIVE memberships whose tenant
 * is also active. A client cannot enumerate or reach a tenant it is not a member
 * of. The "active" flag reflects the session's currently switched-into tenant
 * and falls back to the home tenant when the switched value is stale/revoked.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const memberships = await listMembershipsForUser(session.userId)
  const homeTenantId = session.tenantId ?? (await resolveTenantIdForUser(session.userId)) ?? null

  // The switched-into tenant is only meaningful if the user still holds a live
  // membership there; otherwise the session is effectively scoped to home.
  let activeTenantId = session.activeTenantId ?? homeTenantId
  if (!memberships.some((m) => m.tenantId === activeTenantId)) {
    activeTenantId = homeTenantId
  }

  return NextResponse.json({
    activeTenantId,
    homeTenantId,
    organizations: memberships.map((m) => ({
      tenantId: m.tenantId,
      name: m.tenantName,
      slug: m.tenantSlug,
      tenantRole: m.tenantRole,
      isPrimary: m.isPrimary,
      isHome: m.tenantId === homeTenantId,
      isActive: m.tenantId === activeTenantId,
    })),
  })
}
