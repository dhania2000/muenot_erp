import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { listShopkeepers, provisionShopkeeper, ShopkeeperProvisioningError } from "@/lib/shopkeeper-provisioning"
import type { RawShopkeeperInput } from "@/lib/shopkeeper-provisioning-core"

/**
 * SPEC 15 — Super Admin Shopkeeper directory + provisioning.
 * PLATFORM-axis only: a customer tenant_owner/tenant_admin can never reach it
 * (requirePlatform* consults only the platform axis). Viewing is open to
 * platform staff; provisioning a new Shopkeeper is a high-privilege action
 * restricted to platform super admins.
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const shopkeepers = await listShopkeepers()
  return NextResponse.json({ shopkeepers })
}

export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: RawShopkeeperInput
  try {
    const parsed: unknown = await req.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be an object" }, { status: 400 })
    }
    body = parsed as RawShopkeeperInput
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const result = await provisionShopkeeper(body, { userId: guard.ctx.userId, email: guard.session.email })
    return NextResponse.json({ shopkeeper: result }, { status: 201 })
  } catch (err) {
    if (err instanceof ShopkeeperProvisioningError) {
      return NextResponse.json({ error: err.message, fieldErrors: err.fieldErrors ?? [] }, { status: err.status })
    }
    return NextResponse.json({ error: "Failed to create shopkeeper" }, { status: 500 })
  }
}
