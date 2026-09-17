import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { addAsset, removeAsset } from "@/lib/marketing/planner-db"
import { query } from "@/lib/db"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const assets = await query<any[]>(
    `SELECT * FROM marketing_planner_assets WHERE item_id = ? ORDER BY created_at DESC`,
    [Number(id)],
  ).catch(() => [])
  return NextResponse.json({ assets })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.label || !String(body.label).trim()) {
    return NextResponse.json({ error: "Label is required" }, { status: 400 })
  }
  const assets = await addAsset(
    Number(id),
    {
      label: String(body.label).trim(),
      url: body.url ? String(body.url) : undefined,
      kind: body.kind ? String(body.kind) : undefined,
      library_asset_id: body.library_asset_id ? String(body.library_asset_id) : undefined,
    },
    session.userId,
  )
  return NextResponse.json({ assets })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const url = new URL(request.url)
  const assetId = Number(url.searchParams.get("assetId"))
  if (!assetId) return NextResponse.json({ error: "assetId is required" }, { status: 400 })
  const assets = await removeAsset(Number(id), assetId, session.userId)
  return NextResponse.json({ assets })
}
