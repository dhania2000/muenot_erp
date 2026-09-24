import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getDeal, updateDeal, archiveDeal, DealConflictError, DealNotFoundError, DealValidationError } from "@/lib/sales/deal-pipeline"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const deal = await getDeal(Number(id))
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 })
  return NextResponse.json({ deal })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    await updateDeal(Number(id), body, session.userId, body.row_version)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof DealConflictError) return NextResponse.json({ error: error.message }, { status: 409 })
    if (error instanceof DealNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    if (error instanceof DealValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error("[deals] update failed", error)
    return NextResponse.json({ error: "Unable to update deal." }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    await archiveDeal(Number(id), session.userId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof DealNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[deals] delete failed", error)
    return NextResponse.json({ error: "Unable to delete deal." }, { status: 500 })
  }
}
