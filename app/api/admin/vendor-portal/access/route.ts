import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { getVendorResources, setVendorResources } from "@/lib/vendor-portal/access"
import { getVendorDirectoryRow } from "@/lib/vendor-portal/store"
import { isVendorPortalResource, type VendorPortalResource } from "@/lib/vendor-portal/config"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

export async function GET(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const vendorId = Number(new URL(request.url).searchParams.get("vendorId"))
  if (!vendorId || !(await getVendorDirectoryRow(vendorId))) {
    return NextResponse.json({ error: "Vendor not found" }, { status: 404 })
  }
  const resources = await getVendorResources(tenantId, vendorId)
  return NextResponse.json({ resources })
}

export async function PUT(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const body = await request.json().catch(() => null)
  const vendorId = Number(body?.vendorId)
  const resources: VendorPortalResource[] = Array.isArray(body?.resources)
    ? body.resources.filter((r: unknown): r is VendorPortalResource => typeof r === "string" && isVendorPortalResource(r))
    : []
  if (!vendorId || !(await getVendorDirectoryRow(vendorId))) {
    return NextResponse.json({ error: "Vendor not found" }, { status: 404 })
  }
  await setVendorResources(tenantId, vendorId, resources)
  return NextResponse.json({ resources: await getVendorResources(tenantId, vendorId) })
}
