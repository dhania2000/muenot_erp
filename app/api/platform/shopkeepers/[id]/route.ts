import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { getShopkeeperDetail, updateShopkeeper, setShopkeeperStatus, changeShopkeeperPlan, resetShopkeeperOwnerPassword, deleteShopkeeper, ShopkeeperProvisioningError } from "@/lib/shopkeeper-provisioning"

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

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await req.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be an object" }, { status: 400 })
    }
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const actor = { userId: guard.ctx.userId, email: guard.session.email }
    if (typeof body.status === "string") await setShopkeeperStatus(tenantId, body.status as Parameters<typeof setShopkeeperStatus>[1], actor)
    if (typeof body.planCode === "string") await changeShopkeeperPlan(tenantId, body.planCode, actor)
    if (body.resetPassword) {
      const credentials = await resetShopkeeperOwnerPassword(tenantId, { generate: true }, actor)
      return NextResponse.json({ credentials })
    }
    await updateShopkeeper(tenantId, body, actor)
    const detail = await getShopkeeperDetail(tenantId)
    return NextResponse.json({ detail })
  } catch (err) {
    if (err instanceof ShopkeeperProvisioningError) {
      return NextResponse.json({ error: err.message, fieldErrors: err.fieldErrors ?? [] }, { status: err.status })
    }
    return NextResponse.json({ error: "Failed to update shopkeeper" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const tenantId = parseId(id)
  if (!tenantId) return NextResponse.json({ error: "Invalid shopkeeper id" }, { status: 400 })
  try {
    await deleteShopkeeper(tenantId, { userId: guard.ctx.userId, email: guard.session.email })
    return NextResponse.json({ deleted: true })
  } catch (err) {
    if (err instanceof ShopkeeperProvisioningError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: "Failed to delete shopkeeper" }, { status: 500 })
  }
}
