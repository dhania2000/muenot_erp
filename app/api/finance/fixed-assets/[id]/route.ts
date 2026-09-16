import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getAssetDetail, updateAsset, deleteAsset, loadAsset } from "@/lib/finance-fixed-assets"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const detail = await getAssetDetail(id)
  if (!detail) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
  return NextResponse.json(detail)
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const row = await updateAsset(id, body)
  if (!row) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
  return NextResponse.json({ row })
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const row = await loadAsset(id)
  if (!row) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
  // Only an uncapitalised Draft can be deleted — a posted asset must be
  // disposed / scrapped so the ledger stays balanced and auditable.
  if (row.voucher_no || String(row.posting_status) === "Posted") {
    return NextResponse.json({ error: "A capitalised asset cannot be deleted. Dispose or scrap it instead." }, { status: 409 })
  }
  await deleteAsset(id)
  return NextResponse.json({ ok: true })
}
