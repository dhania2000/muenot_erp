import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse } from "@/lib/dms/request"
import { listCategories, createCategory } from "@/lib/dms"

export const runtime = "nodejs"

export async function GET() {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  return NextResponse.json({ categories: await listCategories() })
}

export async function POST(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? "").trim()
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 })
  const category = await createCategory({
    name,
    color: body.color ? String(body.color) : null,
    description: body.description ? String(body.description) : null,
  })
  return NextResponse.json({ category }, { status: 201 })
}
