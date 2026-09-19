import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getTenantId } from "@/lib/api-auth"
import { createEntity, listEntities, ManagementError } from "@/lib/management"

export const runtime = "nodejs"

export async function GET(req: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { entity } = await params
  const tenantId = await getTenantId()
  const sp = req.nextUrl.searchParams
  try {
    const data = await listEntities(
      entity,
      { search: sp.get("search"), status: sp.get("status") },
      tenantId,
    )
    return NextResponse.json(data)
  } catch (error) {
    if (error instanceof ManagementError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] management list failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to load records." }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { entity } = await params
  const tenantId = await getTenantId()
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await createEntity(entity, body, { userId: session.userId, tenantId })
    return NextResponse.json(detail, { status: 201 })
  } catch (error) {
    if (error instanceof ManagementError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] management create failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to create record." }, { status: 500 })
  }
}
