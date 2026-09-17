import { NextRequest, NextResponse } from "next/server"
import { changeProductStatus, ProductError } from "@/lib/products-db"
import { getProductSession } from "@/lib/products-api-auth"

export const runtime = "nodejs"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canChangeStatus) {
    return NextResponse.json({ error: "You do not have permission to change product status." }, { status: 403 })
  }
  const { id } = await params
  const body = await req.json()
  try {
    const product = await changeProductStatus(
      Number(id),
      String(body.status),
      { userId: ctx.session.userId, userName: ctx.session.name },
      body.reason,
    )
    return NextResponse.json({ ok: true, product })
  } catch (error) {
    if (error instanceof ProductError) return NextResponse.json({ error: error.message }, { status: error.status })
    return NextResponse.json({ error: "Failed to change status." }, { status: 500 })
  }
}
