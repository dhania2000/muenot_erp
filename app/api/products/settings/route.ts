import { NextRequest, NextResponse } from "next/server"
import { getProductSettings, updateProductSettings } from "@/lib/products-db"
import { getProductSession } from "@/lib/products-api-auth"

export const runtime = "nodejs"

export async function GET() {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const settings = await getProductSettings()
  return NextResponse.json({ settings })
}

export async function PATCH(req: NextRequest) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canManageSettings) {
    return NextResponse.json({ error: "You do not have permission to change settings." }, { status: 403 })
  }
  const body = await req.json()
  const settings = await updateProductSettings(body, ctx.session.userId)
  return NextResponse.json({ ok: true, settings })
}
