import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { getShopkeeperDetail, updateShopkeeper, ShopkeeperProvisioningError } from "@/lib/shopkeeper-provisioning"

export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const tenantId = parseId(id)
  if (!tenantId) return NextResponse.json({ error: "Invalid shopkeeper id" }, { status: 400 })
  try {
    const detail = await getShopkeeperDetail(tenantId)
    return NextResponse.json({ detail })
  } catch (err) {
    if (err instanceof ShopkeeperProvisioningError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: "Failed to load shopkeeper" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const tenantId = parseId(id)
  if (!tenantId) return NextResponse.json({ error: "Invalid shopkeeper id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    await updateShopkeeper(tenantId, body, { userId: guard.ctx.userId, email: guard.session.email })
    const detail = await getShopkeeperDetail(tenantId)
    return NextResponse.json({ detail })
  } catch (err) {
    if (err instanceof ShopkeeperProvisioningError) {
      return NextResponse.json({ error: err.message, fieldErrors: err.fieldErrors ?? [] }, { status: err.status })
    }
    return NextResponse.json({ error: "Failed to update shopkeeper" }, { status: 500 })
  }
}
