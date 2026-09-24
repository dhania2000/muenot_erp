import { NextResponse } from "next/server"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { vendorCanAccess } from "@/lib/vendor-portal/access"
import { listItems } from "@/lib/vendor-portal/store"
import { isVendorPortalItemResource, isVendorPortalResource } from "@/lib/vendor-portal/config"

export const runtime = "nodejs"

/**
 * SPEC 119 — Vendor Portal · read a single shared resource (Phase 2).
 * Fail-closed: the vendor must be explicitly granted the resource. tenant +
 * vendor scope are taken from the verified session only.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const session = await getVendorPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const { resource } = await params
  if (!isVendorPortalItemResource(resource) || !isVendorPortalResource(resource)) {
    return NextResponse.json({ error: "Unknown resource" }, { status: 404 })
  }

  const allowed = await vendorCanAccess(session.tenantId, session.vendorId, resource)
  if (!allowed) return NextResponse.json({ error: "Not permitted" }, { status: 403 })

  const items = await listItems(session.tenantId, session.vendorId, resource)
  return NextResponse.json({ items })
}
