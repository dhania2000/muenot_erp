import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createAsset, listAssets } from "@/lib/finance-fixed-assets"

export const runtime = "nodejs"

// Dedicated Fixed Assets register (Phase 3). Unlike the generic config-driven
// modules, the asset lifecycle needs purpose-built endpoints: this route lists
// the register (with a KPI summary) and creates a new asset as a Draft. All
// accounting happens later, through the explicit lifecycle actions, so no
// posting runs here.

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { rows, summary } = await listAssets(req.nextUrl.searchParams)
  return NextResponse.json({ rows, summary })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  if (!body.asset_name) return NextResponse.json({ error: "Asset name is required" }, { status: 400 })
  const row = await createAsset(body, { createdBy: session.userId })
  return NextResponse.json({ row })
}
