import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { getClientResources } from "@/lib/portal/access"

export async function GET() {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ user: null }, { status: 200 })
  const resources = await getClientResources(session.tenantId, session.clientId)
  return NextResponse.json({
    user: { id: session.portalUserId, name: session.name, email: session.email },
    resources,
  })
}
