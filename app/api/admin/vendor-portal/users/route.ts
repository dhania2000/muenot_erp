import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { generateTempPassword } from "@/lib/password"
import {
  createVendorUser,
  getVendorDirectoryRow,
  listVendorUsers,
  setVendorUserStatus,
} from "@/lib/vendor-portal/store"
import { setVendorResources } from "@/lib/vendor-portal/access"
import { isVendorPortalResource, type VendorPortalResource } from "@/lib/vendor-portal/config"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const users = await listVendorUsers(tenantId)
  return NextResponse.json({ users })
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const body = await request.json().catch(() => null)
  const vendorId = Number(body?.vendorId)
  const name = String(body?.name ?? "").trim()
  const email = String(body?.email ?? "").toLowerCase().trim()
  const resources: VendorPortalResource[] = Array.isArray(body?.resources)
    ? body.resources.filter((r: unknown): r is VendorPortalResource => typeof r === "string" && isVendorPortalResource(r))
    : []
  if (!vendorId || !name || !email) {
    return NextResponse.json({ error: "Vendor, name, and email are required" }, { status: 400 })
  }

  if (!(await getVendorDirectoryRow(vendorId))) {
    return NextResponse.json({ error: "Vendor not found" }, { status: 404 })
  }

  const tempPassword = generateTempPassword()
  const user = await createVendorUser({ tenantId, vendorId, email, name, password: tempPassword })
  if (resources.length > 0) await setVendorResources(tenantId, vendorId, resources)

  return NextResponse.json({ user, tempPassword }, { status: 201 })
}

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const body = await request.json().catch(() => null)
  const userId = Number(body?.userId)
  const status = body?.status
  if (!userId || (status !== "active" && status !== "disabled")) {
    return NextResponse.json({ error: "userId and a valid status are required" }, { status: 400 })
  }
  await setVendorUserStatus(tenantId, userId, status)
  return NextResponse.json({ ok: true })
}
