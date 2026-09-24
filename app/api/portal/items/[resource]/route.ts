import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { listItems } from "@/lib/portal/store"
import { isPortalItemResource, isPortalResource } from "@/lib/portal/config"

export async function GET(_request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const { resource } = await params
  if (!isPortalItemResource(resource) || !isPortalResource(resource)) {
    return NextResponse.json({ error: "Unknown resource" }, { status: 404 })
  }

  const allowed = await clientCanAccess(session.tenantId, session.clientId, resource)
  if (!allowed) return NextResponse.json({ error: "Not permitted" }, { status: 403 })

  const items = await listItems(session.tenantId, session.clientId, resource)
  return NextResponse.json({ items })
}
