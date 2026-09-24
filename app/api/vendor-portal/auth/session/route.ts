import { NextResponse } from "next/server"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { getVendorResources } from "@/lib/vendor-portal/access"

export const runtime = "nodejs"

export async function GET() {
  const session = await getVendorPortalSession()
  if (!session) return NextResponse.json({ user: null }, { status: 200 })
  const resources = await getVendorResources(session.tenantId, session.vendorId)
  return NextResponse.json({
    user: { id: session.portalUserId, name: session.name, email: session.email },
    resources,
  })
}
