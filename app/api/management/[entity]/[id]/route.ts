import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getTenantId } from "@/lib/api-auth"
import { deleteEntity, updateEntity, ManagementError } from "@/lib/management"

export const runtime = "nodejs"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ entity: string; id: string }> },
) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { entity, id } = await params
  const tenantId = await getTenantId()
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await updateEntity(entity, decodeURIComponent(id), body, tenantId)
    return NextResponse.json(detail)
  } catch (error) {
    if (error instanceof ManagementError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] management update failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to update record." }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ entity: string; id: string }> },
) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { entity, id } = await params
  const tenantId = await getTenantId()
  try {
    await deleteEntity(entity, decodeURIComponent(id), tenantId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof ManagementError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] management delete failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to delete record." }, { status: 500 })
  }
}
