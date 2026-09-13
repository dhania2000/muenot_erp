import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  acceptQuotation,
  archiveQuotation,
  cancelQuotation,
  convertToContract,
  convertToInvoice,
  duplicateQuotation,
  markQuotationSent,
  QuotationError,
  rejectQuotation,
  renewValidity,
  reviseQuotation,
} from "@/lib/sales/quotation-service"

/**
 * Single dispatcher for every quotation lifecycle transition and conversion.
 * Body: { action: "send" | "accept" | "reject" | "cancel" | "renew" |
 *         "revise" | "duplicate" | "convert-contract" | "convert-invoice", ... }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const quotationId = Number(id)
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")
  const userId = session.userId

  try {
    switch (action) {
      case "send":
        await markQuotationSent(quotationId, userId, body.via || "manual")
        return NextResponse.json({ success: true })
      case "accept":
        await acceptQuotation(quotationId, userId, body.note)
        return NextResponse.json({ success: true })
      case "reject":
        await rejectQuotation(quotationId, userId, body.reason, body.notes)
        return NextResponse.json({ success: true })
      case "cancel":
        await cancelQuotation(quotationId, userId, body.reason)
        return NextResponse.json({ success: true })
      case "archive":
        await archiveQuotation(quotationId, userId)
        return NextResponse.json({ success: true })
      case "renew":
        if (!body.valid_until) return NextResponse.json({ error: "valid_until is required" }, { status: 400 })
        await renewValidity(quotationId, body.valid_until, userId)
        return NextResponse.json({ success: true })
      case "revise":
        return NextResponse.json(await reviseQuotation(quotationId, userId))
      case "duplicate":
        return NextResponse.json(await duplicateQuotation(quotationId, userId))
      case "convert-contract":
        return NextResponse.json(
          await convertToContract(quotationId, userId, {
            start_date: body.start_date,
            end_date: body.end_date,
            contract_type: body.contract_type,
          }),
        )
      case "convert-invoice":
        return NextResponse.json(await convertToInvoice(quotationId, userId))
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof QuotationError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: (err as any)?.message || "Action failed" }, { status: 500 })
  }
}
