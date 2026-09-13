import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  archiveQuotation,
  getQuotationDetail,
  QuotationError,
  updateDraftQuotation,
  type QuotationInput,
} from "@/lib/sales/quotation-service"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const detail = await getQuotationDetail(Number(id))
  if (!detail) return NextResponse.json({ error: "Quotation not found" }, { status: 404 })
  return NextResponse.json(detail)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = (await request.json()) as QuotationInput
  try {
    await updateDraftQuotation(Number(id), body, session.userId)
    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof QuotationError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: "Unable to update quotation" }, { status: 500 })
  }
}

// DELETE archives the quotation (soft delete) so history and numbering are
// preserved. Hard deletion is intentionally not offered.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  await archiveQuotation(Number(id), session.userId)
  return NextResponse.json({ success: true })
}
