import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listActiveBreakGlassForUser } from "@/lib/temporary-access-store"

export const dynamic = "force-dynamic"

/**
 * "no silent usage": the signed-in user's own currently-active
 * break-glass grants, powering the persistent, app-wide banner. Scoped to the
 * caller so it never leaks another user's elevation.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ active: [] })
  const tenantId = session.impersonatedTenantId ?? session.tenantId
  if (tenantId == null) return NextResponse.json({ active: [] })
  try {
    const active = await listActiveBreakGlassForUser(tenantId, session.userId)
    return NextResponse.json({ active })
  } catch (err) {
    console.error("[security/emergency-access/active] read failed:", err)
    return NextResponse.json({ active: [] })
  }
}
