import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse } from "@/lib/dms/request"
import { listFolders, createFolder } from "@/lib/dms"

export const runtime = "nodejs"

export async function GET() {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  return NextResponse.json({ folders: await listFolders() })
}

export async function POST(req: NextRequest) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? "").trim()
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 })
  const parentId = body.parentId == null ? null : Number(body.parentId)
  const folder = await createFolder({
    name,
    parentId,
    ownerId: ctx.session.userId,
    createdBy: ctx.session.userId,
  })
  return NextResponse.json({ folder }, { status: 201 })
}
