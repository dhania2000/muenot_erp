import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import { deleteWarranty, updateWarranty, AssetLifecycleError } from "@/lib/asset-lifecycle"

export const runtime = "nodejs"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireModuleAction("assets.employee_assets", "edit")
  if (!session)
    return NextResponse.json({ error: "You do not have permission to edit warranties." }, { status: 403 })
  const { id } = await params
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await updateWarranty(id, body, session)
    return NextResponse.json(detail)
  } catch (error) {
    if (error instanceof AssetLifecycleError)
      return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] update warranty failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to update warranty." }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireModuleAction("assets.employee_assets", "delete")
  if (!session)
    return NextResponse.json({ error: "You do not have permission to remove warranties." }, { status: 403 })
  const { id } = await params
  try {
    const detail = await deleteWarranty(id, session)
    return NextResponse.json(detail)
  } catch (error) {
    if (error instanceof AssetLifecycleError)
      return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] delete warranty failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to remove warranty." }, { status: 500 })
  }
}
