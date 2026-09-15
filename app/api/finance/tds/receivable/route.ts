import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  tdsReceivableLedger,
  listReceivableReceipts,
  recordReceivableReceipt,
  deleteReceivableReceipt,
} from "@/lib/finance-tds-receivable"

const FEATURE = "finance.tds_filing"
const MODULE = "finance.tds_filing"

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const fy = req.nextUrl.searchParams.get("fy") || ""
  try {
    const [ledger, receipts] = await Promise.all([tdsReceivableLedger(fy), listReceivableReceipts(fy)])
    return NextResponse.json({ ...ledger, receipts })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "record_challan")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    const result = await recordReceivableReceipt({
      financialYear: String(body.financial_year || ""),
      partyId: body.party_id ?? null,
      partyName: body.party_name ?? null,
      pan: body.pan ?? null,
      section: body.section ?? null,
      sourceModule: body.source_module ?? "Sales Invoice",
      sourceTxnId: body.source_txn_id ?? null,
      invoiceRef: body.invoice_ref ?? null,
      mode: body.mode === "Adjusted" ? "Adjusted" : "Received",
      amount: Number(body.amount || 0),
      receiptDate: body.receipt_date ?? null,
      certificateRef: body.certificate_ref ?? null,
      note: body.note ?? null,
      idempotencyKey: body.idempotency_key ?? null,
      actorId: session.userId,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "record_challan")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = req.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "Receipt id is required." }, { status: 400 })
  try {
    return NextResponse.json(await deleteReceivableReceipt(id, session.userId))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
