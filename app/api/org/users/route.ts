import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"

const FEATURE = "organization.hierarchy"

/**
 * Assignable users for the current tenant. Used by the hierarchy UI to pick a
 * unit head or add members. Scoped to the acting tenant so a picker can never
 * surface another organization's people.
 */
export async function GET(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(FEATURE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const tenantId = currentTenantId()
  const users = await query<any[]>(
    `SELECT id, name, email, role FROM users WHERE tenant_id = ? AND status <> 'inactive' ORDER BY name ASC`,
    [tenantId],
  ).catch(async () =>
    // `status` column may not exist on legacy user tables — fall back gracefully.
    query<any[]>(`SELECT id, name, email, role FROM users WHERE tenant_id = ? ORDER BY name ASC`, [tenantId]),
  )
  return NextResponse.json({ users })
}
